import { afterEach, describe, expect, it, vi } from "vitest";
import { zipSync } from "fflate";
import {
	CREATE_ARCHIVE_UPLOAD_TOOL,
	GET_ARCHIVE_UPLOAD_STATUS_TOOL,
	handleArchiveUploadStatusHttp,
	handleCreateArchiveUpload,
	handleGetArchiveUploadStatus,
	type ArchiveUploadEnv,
} from "./archive-upload";
import {
	buildStatusPayload,
	formatArchiveUploadLimits,
	sessionKvKey,
	uploadIdFromObjectKey,
	type ArchiveUploadSession,
} from "./archive-upload-session";
import {
	extractZipArchive,
	isRetryableGitHubStatus,
	isTransientError,
	isUtf8Text,
	partitionFilesForTree,
	processR2Event,
	type ExtractedFile,
} from "./archive-upload-process";

describe("tool schemas", () => {
	it("declares create_archive_upload fields", () => {
		expect(CREATE_ARCHIVE_UPLOAD_TOOL.name).toBe("create_archive_upload");
		expect(CREATE_ARCHIVE_UPLOAD_TOOL.inputSchema.required).toEqual([
			"owner",
			"repo",
			"branch",
			"message",
		]);
	});

	it("documents archive size limits in create_archive_upload description", () => {
		const limits = formatArchiveUploadLimits();
		expect(limits).toContain("50 MiB");
		expect(limits).toContain("100 MiB");
		expect(limits).toContain("1000 files");
		expect(limits).toContain("10 MiB");
		expect(CREATE_ARCHIVE_UPLOAD_TOOL.description).toContain(limits);
		expect(CREATE_ARCHIVE_UPLOAD_TOOL.description).toMatch(/Size limits/i);
	});

	it("declares get_archive_upload_status fields", () => {
		expect(GET_ARCHIVE_UPLOAD_STATUS_TOOL.name).toBe("get_archive_upload_status");
		expect(GET_ARCHIVE_UPLOAD_STATUS_TOOL.inputSchema.required).toEqual(["upload_id"]);
	});
});

describe("uploadIdFromObjectKey", () => {
	it("parses archive object keys", () => {
		expect(uploadIdFromObjectKey("archive-uploads/abc-123/archive.zip")).toBe("abc-123");
	});

	it("ignores lock objects and unrelated keys", () => {
		expect(uploadIdFromObjectKey("archive-uploads/abc-123/.lock")).toBeNull();
		expect(uploadIdFromObjectKey("other/abc/archive.zip")).toBeNull();
	});
});

describe("extractZipArchive", () => {
	it("extracts files and strips a shared root directory", () => {
		const zipped = zipSync({
			"root/README.md": new TextEncoder().encode("# hi"),
			"root/src/main.ts": new TextEncoder().encode("console.log(1)"),
		});
		const files = extractZipArchive(zipped);
		const paths = files.map((f) => f.path).sort();
		expect(paths).toEqual(["README.md", "src/main.ts"]);
	});

	it("rejects zip-slip paths", () => {
		const zipped = zipSync({
			"../evil.txt": new TextEncoder().encode("nope"),
		});
		expect(() => extractZipArchive(zipped)).toThrow(/unsafe path/i);
	});
});

describe("buildStatusPayload", () => {
	it("reports reflected=false while awaiting upload", () => {
		const payload = buildStatusPayload(baseSession({ status: "awaiting_upload" }));
		expect(payload.reflected).toBe(false);
		expect(payload.status).toBe("awaiting_upload");
	});

	it("reports reflected=true when committed and mentions ignored duplicates", () => {
		const payload = buildStatusPayload(
			baseSession({
				status: "committed",
				commit_sha: "abc",
				ignored_duplicate_uploads: 2,
			}),
		);
		expect(payload.reflected).toBe(true);
		expect(payload.ignored_duplicate_uploads).toBe(2);
		expect(String(payload.message)).toMatch(/subsequent upload/i);
	});
});

describe("handleCreateArchiveUpload", () => {
	afterEach(() => vi.restoreAllMocks());

	it("rejects missing args without touching KV", async () => {
		const env = mockEnv();
		const put = vi.spyOn(env.OAUTH_KV, "put");
		const result = await handleCreateArchiveUpload(
			{ owner: "o" },
			"token",
			"user",
			env,
			"https://example.com",
		);
		expect(result.isError).toBe(true);
		expect(put).not.toHaveBeenCalled();
	});

	it("rejects unsupported formats", async () => {
		const result = await handleCreateArchiveUpload(
			{ owner: "o", repo: "r", branch: "main", message: "m", format: "tar.gz" },
			"token",
			"user",
			mockEnv(),
			"https://example.com",
		);
		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toMatch(/Only 'zip'/);
	});
});

describe("handleGetArchiveUploadStatus / HTTP", () => {
	it("returns JSON status without leaking the access token", async () => {
		const env = mockEnv();
		const session = baseSession({ status: "committed", commit_sha: "deadbeef" });
		await env.OAUTH_KV.put(sessionKvKey(session.upload_id), JSON.stringify(session));

		const toolResult = await handleGetArchiveUploadStatus(
			{ upload_id: session.upload_id },
			env,
		);
		expect(toolResult.isError).toBeUndefined();
		expect(toolResult.content[0]?.text).toContain("deadbeef");
		expect(toolResult.content[0]?.text).not.toContain("ghs_secret");

		const http = await handleArchiveUploadStatusHttp(session.upload_id, env);
		expect(http.status).toBe(200);
		const body = await http.json();
		expect(body).toMatchObject({ reflected: true, commit_sha: "deadbeef" });
		expect(JSON.stringify(body)).not.toContain("ghs_secret");
	});

	it("404s unknown ids", async () => {
		const http = await handleArchiveUploadStatusHttp("missing", mockEnv());
		expect(http.status).toBe(404);
	});
});

describe("processR2Event one-shot behavior", () => {
	afterEach(() => vi.restoreAllMocks());

	it("increments ignored_duplicate_uploads when already committed", async () => {
		const env = mockEnv();
		const session = baseSession({
			status: "committed",
			commit_sha: "abc",
			committed_etag: "etag-1",
			object_key: "archive-uploads/u1/archive.zip",
			upload_id: "u1",
		});
		await env.OAUTH_KV.put(sessionKvKey("u1"), JSON.stringify(session));

		await processR2Event(
			{
				action: "PutObject",
				object: {
					key: "archive-uploads/u1/archive.zip",
					eTag: "etag-2",
					size: 10,
				},
				eventTime: "2026-01-01T00:00:00Z",
			},
			env,
		);

		const updated = JSON.parse(
			(await env.OAUTH_KV.get(sessionKvKey("u1")))!,
		) as ArchiveUploadSession;
		expect(updated.ignored_duplicate_uploads).toBe(1);
		expect(updated.status).toBe("committed");
		expect(updated.commit_sha).toBe("abc");
	});

	it("does not count queue redelivery of the same etag as a duplicate upload", async () => {
		const env = mockEnv();
		const session = baseSession({
			status: "committed",
			commit_sha: "abc",
			committed_etag: "etag-1",
			object_key: "archive-uploads/u1/archive.zip",
			upload_id: "u1",
		});
		await env.OAUTH_KV.put(sessionKvKey("u1"), JSON.stringify(session));

		await processR2Event(
			{
				action: "PutObject",
				object: {
					key: "archive-uploads/u1/archive.zip",
					eTag: "etag-1",
					size: 10,
				},
				eventTime: "2026-01-01T00:00:00Z",
			},
			env,
		);

		const updated = JSON.parse(
			(await env.OAUTH_KV.get(sessionKvKey("u1")))!,
		) as ArchiveUploadSession;
		expect(updated.ignored_duplicate_uploads).toBe(0);
	});

	it("expands a zip and commits to GitHub for a new branch", async () => {
		const env = mockEnv();
		const session = baseSession({
			status: "awaiting_upload",
			object_key: "archive-uploads/u1/archive.zip",
			upload_id: "u1",
		});
		await env.OAUTH_KV.put(sessionKvKey("u1"), JSON.stringify(session));

		const zip = zipSync({
			"proj/hello.txt": new TextEncoder().encode("hello"),
		});
		await env.ARCHIVE_UPLOADS.put("archive-uploads/u1/archive.zip", zip);

		const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const url = String(input);
			const method = (init?.method ?? "GET").toUpperCase();
			if (url.endsWith("/git/blobs") && method === "POST") {
				return jsonRes({ sha: "blob1" });
			}
			if (url.endsWith("/git/trees") && method === "POST") {
				return jsonRes({ sha: "tree1" });
			}
			if (url.includes("/git/refs/heads/") && method === "GET") {
				return new Response("missing", { status: 404 });
			}
			if (url.endsWith("/git/commits") && method === "POST") {
				return jsonRes({ sha: "commit1" });
			}
			if (url.endsWith("/git/refs") && method === "POST") {
				return jsonRes({ ref: "refs/heads/main" });
			}
			return new Response(`unexpected ${method} ${url}`, { status: 500 });
		});

		await processR2Event(
			{
				action: "PutObject",
				object: {
					key: "archive-uploads/u1/archive.zip",
					eTag: "etag-new",
					size: zip.byteLength,
				},
				eventTime: "2026-01-01T00:00:01Z",
			},
			env,
		);

		const updated = JSON.parse(
			(await env.OAUTH_KV.get(sessionKvKey("u1")))!,
		) as ArchiveUploadSession;
		expect(updated.status).toBe("committed");
		expect(updated.commit_sha).toBe("commit1");
		expect(updated.committed_etag).toBe("etag-new");
		expect(fetchMock).toHaveBeenCalled();

		// Text-only archives should inline content in Create Tree (no per-file blobs).
		const blobPosts = fetchMock.mock.calls.filter(([input, init]) => {
			const url = String(input);
			const method = ((init as RequestInit | undefined)?.method ?? "GET").toUpperCase();
			return url.endsWith("/git/blobs") && method === "POST";
		});
		expect(blobPosts).toHaveLength(0);

		const treePost = fetchMock.mock.calls.find(([input, init]) => {
			const url = String(input);
			const method = ((init as RequestInit | undefined)?.method ?? "GET").toUpperCase();
			return url.endsWith("/git/trees") && method === "POST";
		});
		expect(treePost).toBeTruthy();
		const treeBody = JSON.parse(String((treePost![1] as RequestInit).body)) as {
			tree: Array<{ path: string; content?: string; sha?: string }>;
		};
		expect(treeBody.tree).toEqual([
			expect.objectContaining({ path: "hello.txt", content: "hello" }),
		]);
		expect(treeBody.tree[0]?.sha).toBeUndefined();
	});

	it("creates blobs only for binary files, still committing text via tree content", async () => {
		const env = mockEnv();
		const session = baseSession({
			status: "awaiting_upload",
			object_key: "archive-uploads/u1/archive.zip",
			upload_id: "u1",
		});
		await env.OAUTH_KV.put(sessionKvKey("u1"), JSON.stringify(session));

		const zip = zipSync({
			"proj/readme.md": new TextEncoder().encode("# hi"),
			"proj/data.bin": new Uint8Array([0, 1, 2, 255]),
		});
		await env.ARCHIVE_UPLOADS.put("archive-uploads/u1/archive.zip", zip);

		const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const url = String(input);
			const method = (init?.method ?? "GET").toUpperCase();
			if (url.endsWith("/git/blobs") && method === "POST") {
				return jsonRes({ sha: "blob-bin" });
			}
			if (url.endsWith("/git/trees") && method === "POST") {
				return jsonRes({ sha: "tree1" });
			}
			if (url.includes("/git/refs/heads/") && method === "GET") {
				return new Response("missing", { status: 404 });
			}
			if (url.endsWith("/git/commits") && method === "POST") {
				return jsonRes({ sha: "commit1" });
			}
			if (url.endsWith("/git/refs") && method === "POST") {
				return jsonRes({ ref: "refs/heads/main" });
			}
			return new Response(`unexpected ${method} ${url}`, { status: 500 });
		});

		await processR2Event(
			{
				action: "PutObject",
				object: {
					key: "archive-uploads/u1/archive.zip",
					eTag: "etag-bin",
					size: zip.byteLength,
				},
				eventTime: "2026-01-01T00:00:02Z",
			},
			env,
		);

		const updated = JSON.parse(
			(await env.OAUTH_KV.get(sessionKvKey("u1")))!,
		) as ArchiveUploadSession;
		expect(updated.status).toBe("committed");
		expect(updated.commit_sha).toBe("commit1");

		const blobPosts = fetchMock.mock.calls.filter(([input, init]) => {
			const url = String(input);
			const method = ((init as RequestInit | undefined)?.method ?? "GET").toUpperCase();
			return url.endsWith("/git/blobs") && method === "POST";
		});
		expect(blobPosts).toHaveLength(1);

		const treePost = fetchMock.mock.calls.find(([input, init]) => {
			const url = String(input);
			const method = ((init as RequestInit | undefined)?.method ?? "GET").toUpperCase();
			return url.endsWith("/git/trees") && method === "POST";
		});
		const treeBody = JSON.parse(String((treePost![1] as RequestInit).body)) as {
			tree: Array<{ path: string; content?: string; sha?: string }>;
		};
		const byPath = Object.fromEntries(treeBody.tree.map((e) => [e.path, e]));
		expect(byPath["readme.md"]).toEqual(
			expect.objectContaining({ path: "readme.md", content: "# hi" }),
		);
		expect(byPath["data.bin"]).toEqual(
			expect.objectContaining({ path: "data.bin", sha: "blob-bin" }),
		);
		expect(byPath["data.bin"]?.content).toBeUndefined();
	});
});


describe("commit rate-limit helpers", () => {
	it("detects UTF-8 text vs binary", () => {
		expect(isUtf8Text(new TextEncoder().encode("hello"))).toBe(true);
		expect(isUtf8Text(new Uint8Array([0, 1, 2]))).toBe(false);
		expect(isUtf8Text(new Uint8Array([0xff, 0xfe, 0xfd]))).toBe(false);
	});

	it("inlines UTF-8 files and routes binary to blob creation", () => {
		const files: ExtractedFile[] = [
			{ path: "a.txt", content: new TextEncoder().encode("a"), mode: "100644" },
			{ path: "b.bin", content: new Uint8Array([0, 255]), mode: "100644" },
		];
		const { inline, needBlob } = partitionFilesForTree(files);
		expect(inline.map((f) => f.path)).toEqual(["a.txt"]);
		expect(needBlob.map((f) => f.path)).toEqual(["b.bin"]);
	});

	it("treats GitHub secondary rate limit responses as transient/retryable", () => {
		const body =
			'{"message":"You have exceeded a secondary rate limit. Please wait a few minutes before you try again."}';
		expect(isRetryableGitHubStatus(403, body)).toBe(true);
		expect(isRetryableGitHubStatus(403, '{"message":"Resource not accessible"}')).toBe(
			false,
		);
		expect(isRetryableGitHubStatus(429, "{}")).toBe(true);
		expect(
			isTransientError(
				`create blob for 'x' failed: 403 ${body}`,
			),
		).toBe(true);
		expect(isTransientError("create blob for 'x' failed: 403 nope")).toBe(false);
	});
});


function jsonRes(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function baseSession(
	overrides: Partial<ArchiveUploadSession> = {},
): ArchiveUploadSession {
	return {
		upload_id: "u1",
		object_key: "archive-uploads/u1/archive.zip",
		owner: "o",
		repo: "r",
		branch: "main",
		message: "import",
		format: "zip",
		status: "awaiting_upload",
		access_token: "ghs_secret",
		created_at: new Date().toISOString(),
		expires_at: new Date(Date.now() + 900_000).toISOString(),
		created_by: "user",
		ignored_duplicate_uploads: 0,
		processed_event_ids: [],
		...overrides,
	};
}

function mockEnv(): ArchiveUploadEnv {
	const store = new Map<string, string>();
	const objects = new Map<string, Uint8Array>();

	const kv = {
		get: async (key: string) => store.get(key) ?? null,
		put: async (key: string, value: string) => {
			store.set(key, value);
		},
		delete: async (key: string) => {
			store.delete(key);
		},
	} as unknown as KVNamespace;

	const r2 = {
		get: async (key: string) => {
			const data = objects.get(key);
			if (!data) return null;
			return {
				size: data.byteLength,
				arrayBuffer: async () => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
			};
		},
		put: async (
			key: string,
			value: string | ArrayBuffer | Uint8Array,
			opts?: { onlyIf?: { etagDoesNotMatch?: string } },
		) => {
			if (opts?.onlyIf?.etagDoesNotMatch === "*" && objects.has(key)) {
				return null;
			}
			const bytes =
				typeof value === "string"
					? new TextEncoder().encode(value)
					: value instanceof Uint8Array
						? value
						: new Uint8Array(value);
			objects.set(key, bytes);
			return { key };
		},
		delete: async (keys: string | string[]) => {
			for (const k of Array.isArray(keys) ? keys : [keys]) objects.delete(k);
		},
	} as unknown as R2Bucket;

	return {
		OAUTH_KV: kv,
		ARCHIVE_UPLOADS: r2,
		R2_ACCOUNT_ID: "acct",
		R2_ACCESS_KEY_ID: "key",
		R2_SECRET_ACCESS_KEY: "secret",
		R2_BUCKET_NAME: "github-mcp-proxy-archive-uploads",
	};
}
