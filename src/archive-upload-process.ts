import { unzipSync } from "fflate";
import {
	ArchiveUploadSession,
	MAX_ARCHIVE_BYTES,
	MAX_EXTRACTED_BYTES,
	MAX_FILE_BYTES,
	MAX_FILE_COUNT,
	SESSION_TTL_PADDING_SECONDS,
	lockObjectKey,
	sessionKvKey,
	uploadIdFromObjectKey,
} from "./archive-upload-session";
import type { ArchiveUploadEnv } from "./archive-upload";

/** R2 event notification payload delivered via Queues. */
export interface R2EventNotification {
	account?: string;
	action?: string;
	bucket?: string;
	object?: {
		key?: string;
		size?: number;
		eTag?: string;
	};
	eventTime?: string;
}

export interface ExtractedFile {
	path: string;
	content: Uint8Array;
	mode: "100644" | "100755";
}

/**
 * Expand a zip archive into flat file entries.
 * Strips a single shared top-level directory (GitHub zipball style).
 * Rejects zip-slip paths and enforces size/count limits.
 */
export function extractZipArchive(data: Uint8Array): ExtractedFile[] {
	if (data.byteLength > MAX_ARCHIVE_BYTES) {
		throw new Error(
			`archive exceeds max size of ${MAX_ARCHIVE_BYTES} bytes (got ${data.byteLength})`,
		);
	}

	let raw: Record<string, Uint8Array>;
	try {
		raw = unzipSync(data);
	} catch (e) {
		throw new Error(`invalid or corrupt zip: ${String(e)}`);
	}

	const entries: { path: string; content: Uint8Array }[] = [];
	let extractedBytes = 0;

	for (const [name, content] of Object.entries(raw)) {
		if (!name || name.endsWith("/")) continue;
		if (name.includes("__MACOSX/") || name.endsWith(".DS_Store")) continue;

		const normalized = name.replace(/\\/g, "/").replace(/^\/+/, "");
		if (!normalized || normalized.split("/").includes("..")) {
			throw new Error(`refusing unsafe path in archive: ${name}`);
		}

		extractedBytes += content.byteLength;
		if (extractedBytes > MAX_EXTRACTED_BYTES) {
			throw new Error(
				`extracted content exceeds max of ${MAX_EXTRACTED_BYTES} bytes`,
			);
		}
		if (content.byteLength > MAX_FILE_BYTES) {
			throw new Error(
				`file '${normalized}' exceeds max file size of ${MAX_FILE_BYTES} bytes`,
			);
		}

		entries.push({ path: normalized, content });
	}

	if (entries.length === 0) {
		throw new Error("archive contains no files");
	}
	if (entries.length > MAX_FILE_COUNT) {
		throw new Error(
			`archive has ${entries.length} files; max is ${MAX_FILE_COUNT}`,
		);
	}

	const stripped = stripCommonRoot(entries);
	return stripped.map((e) => ({
		path: e.path,
		content: e.content,
		mode: "100644" as const,
	}));
}

function stripCommonRoot(
	entries: { path: string; content: Uint8Array }[],
): { path: string; content: Uint8Array }[] {
	if (entries.length === 0) return entries;
	const first = entries[0].path;
	const slash = first.indexOf("/");
	if (slash <= 0) return entries;
	const root = first.slice(0, slash + 1);
	if (!entries.every((e) => e.path.startsWith(root))) return entries;
	return entries.map((e) => ({
		path: e.path.slice(root.length),
		content: e.content,
	}));
}

export async function handleArchiveUploadQueue(
	batch: MessageBatch<R2EventNotification>,
	env: ArchiveUploadEnv,
): Promise<void> {
	for (const message of batch.messages) {
		try {
			await processR2Event(message.body, env);
			message.ack();
		} catch (e) {
			console.error("archive-upload queue handler error:", e);
			message.retry();
		}
	}
}

export async function processR2Event(
	event: R2EventNotification,
	env: ArchiveUploadEnv,
): Promise<void> {
	const action = event.action ?? "";
	if (
		action &&
		action !== "PutObject" &&
		action !== "CopyObject" &&
		action !== "CompleteMultipartUpload"
	) {
		return;
	}

	const key = event.object?.key;
	if (!key) return;

	const uploadId = uploadIdFromObjectKey(key);
	if (!uploadId) return;

	const etag = event.object?.eTag ?? "";
	const eventId = `${key}:${etag}:${event.eventTime ?? ""}`;

	const kvKey = sessionKvKey(uploadId);
	const raw = await env.OAUTH_KV.get(kvKey);
	if (!raw) {
		console.warn(`archive-upload: no session for ${uploadId}, ignoring`);
		return;
	}

	let session: ArchiveUploadSession;
	try {
		session = JSON.parse(raw) as ArchiveUploadSession;
	} catch {
		console.error(`archive-upload: corrupt session for ${uploadId}`);
		return;
	}

	if (session.object_key !== key) {
		console.warn(`archive-upload: key mismatch for ${uploadId}`);
		return;
	}

	// One-shot: already committed (or failed permanently) → count ignored uploads.
	if (session.status === "committed" || session.status === "failed") {
		if (session.committed_etag && etag && session.committed_etag === etag) {
			// Queue redelivery of the same object version — pure dedupe, don't count.
			return;
		}
		if (session.processed_event_ids.includes(eventId)) {
			return;
		}
		session.ignored_duplicate_uploads += 1;
		session.processed_event_ids = pushCapped(session.processed_event_ids, eventId, 20);
		await putSession(env, session);
		return;
	}

	if (session.processed_event_ids.includes(eventId)) {
		return;
	}

	// Best-effort exclusive lock via R2 conditional create.
	const lockKey = lockObjectKey(uploadId);
	const lock = await env.ARCHIVE_UPLOADS.put(lockKey, "1", {
		onlyIf: { etagDoesNotMatch: "*" },
		customMetadata: { started_at: new Date().toISOString() },
	});
	if (lock === null) {
		// Another consumer holds the lock (or leftover). If still awaiting, leave for retry.
		console.warn(`archive-upload: lock busy for ${uploadId}`);
		throw new Error(`lock busy for ${uploadId}`);
	}

	try {
		session.status = "processing";
		session.processed_event_ids = pushCapped(session.processed_event_ids, eventId, 20);
		await putSession(env, session);

		const obj = await env.ARCHIVE_UPLOADS.get(key);
		if (!obj) {
			throw new Error(`object '${key}' not found in R2 after upload event`);
		}
		if (obj.size > MAX_ARCHIVE_BYTES) {
			throw new Error(
				`archive size ${obj.size} exceeds limit ${MAX_ARCHIVE_BYTES}`,
			);
		}

		const bytes = new Uint8Array(await obj.arrayBuffer());
		const files = extractZipArchive(bytes);
		const commitSha = await commitFilesToGitHub(session, files);

		session.status = "committed";
		session.commit_sha = commitSha;
		session.committed_etag = etag || undefined;
		session.error = undefined;
		await putSession(env, session);

		// Best-effort cleanup of archive + lock.
		await env.ARCHIVE_UPLOADS.delete([key, lockKey]);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		try {
			await env.ARCHIVE_UPLOADS.delete(lockKey);
		} catch {
			/* ignore */
		}
		// Transient errors: release lock and keep session retryable.
		if (isTransientError(msg)) {
			session.status = "awaiting_upload";
			session.error = msg;
			await putSession(env, session);
			throw e;
		}
		session.status = "failed";
		session.error = msg;
		await putSession(env, session);
		console.error(`archive-upload: permanent failure for ${uploadId}: ${msg}`);
	}
}

async function putSession(
	env: ArchiveUploadEnv,
	session: ArchiveUploadSession,
): Promise<void> {
	const expiresMs = Date.parse(session.expires_at);
	const now = Date.now();
	const ttlPadding = sessionTtlFromExpires(expiresMs, now);
	await env.OAUTH_KV.put(sessionKvKey(session.upload_id), JSON.stringify(session), {
		expirationTtl: ttlPadding,
	});
}

function sessionTtlFromExpires(expiresMs: number, now: number): number {
	if (!Number.isFinite(expiresMs)) {
		return SESSION_TTL_PADDING_SECONDS + 900;
	}
	const seconds = Math.ceil((expiresMs - now) / 1000) + SESSION_TTL_PADDING_SECONDS;
	return Math.max(60, Math.min(seconds, 604800));
}

function pushCapped(list: string[], item: string, max: number): string[] {
	const next = list.includes(item) ? list.slice() : [...list, item];
	if (next.length > max) return next.slice(next.length - max);
	return next;
}

function isTransientError(msg: string): boolean {
	return /(?:^|\D)(429|502|503|504)(?:\D|$)|network|fetch failed|lock busy/i.test(
		msg,
	);
}

interface TreeEntry {
	path: string;
	mode: "100644" | "100755";
	type: "blob";
	sha: string;
}

async function commitFilesToGitHub(
	session: ArchiveUploadSession,
	files: ExtractedFile[],
): Promise<string> {
	const { owner, repo, branch, message, access_token: token } = session;
	const api = (path: string, init?: RequestInit) =>
		fetch(`https://api.github.com${path}`, {
			...init,
			headers: {
				Authorization: `Bearer ${token}`,
				Accept: "application/vnd.github+json",
				"User-Agent": "github-mcp-proxy",
				...(init?.headers ?? {}),
			},
		});

	const treeEntries: TreeEntry[] = [];
	// Create blobs with limited concurrency.
	const concurrency = 6;
	for (let i = 0; i < files.length; i += concurrency) {
		const chunk = files.slice(i, i + concurrency);
		const shas = await Promise.all(
			chunk.map(async (file) => {
				const blobRes = await api(`/repos/${owner}/${repo}/git/blobs`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						content: bytesToBase64(file.content),
						encoding: "base64",
					}),
				});
				if (!blobRes.ok) {
					throw new Error(
						`create blob for '${file.path}' failed: ${blobRes.status} ${await blobRes.text()}`,
					);
				}
				const data = (await blobRes.json()) as { sha: string };
				return data.sha;
			}),
		);
		for (let j = 0; j < chunk.length; j++) {
			treeEntries.push({
				path: chunk[j].path,
				mode: chunk[j].mode,
				type: "blob",
				sha: shas[j],
			});
		}
	}

	// Full tree replace (no base_tree): archive contents become the branch snapshot.
	const treeRes = await api(`/repos/${owner}/${repo}/git/trees`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ tree: treeEntries }),
	});
	if (!treeRes.ok) {
		throw new Error(`create tree failed: ${treeRes.status} ${await treeRes.text()}`);
	}
	const treeData = (await treeRes.json()) as { sha: string };

	const refRes = await api(
		`/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(branch)}`,
	);

	let parents: string[] = [];
	if (refRes.status === 200) {
		const refData = (await refRes.json()) as { object: { sha: string } };
		parents = [refData.object.sha];
	} else if (refRes.status !== 404) {
		throw new Error(
			`fetch branch ref failed: ${refRes.status} ${await refRes.text()}`,
		);
	}

	const commitRes = await api(`/repos/${owner}/${repo}/git/commits`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			message,
			tree: treeData.sha,
			parents,
		}),
	});
	if (!commitRes.ok) {
		throw new Error(
			`create commit failed: ${commitRes.status} ${await commitRes.text()}`,
		);
	}
	const commitData = (await commitRes.json()) as { sha: string };

	if (parents.length === 0) {
		const createRef = await api(`/repos/${owner}/${repo}/git/refs`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				ref: `refs/heads/${branch}`,
				sha: commitData.sha,
			}),
		});
		if (!createRef.ok) {
			throw new Error(
				`create ref failed: ${createRef.status} ${await createRef.text()}`,
			);
		}
	} else {
		const updateRef = await api(
			`/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(branch)}`,
			{
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ sha: commitData.sha, force: false }),
			},
		);
		if (!updateRef.ok) {
			throw new Error(
				`update ref failed: ${updateRef.status} ${await updateRef.text()}`,
			);
		}
	}

	return commitData.sha;
}

function bytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	const chunk = 0x8000;
	for (let i = 0; i < bytes.length; i += chunk) {
		binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
	}
	return btoa(binary);
}
