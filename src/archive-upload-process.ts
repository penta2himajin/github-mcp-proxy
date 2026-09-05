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

/**
 * Transient / retryable failures for the queue consumer.
 * GitHub secondary rate limits often return HTTP 403 (not 429) with a
 * "secondary rate limit" message — treat those as transient too.
 */
export function isTransientError(msg: string): boolean {
	return (
		/(?:^|\D)(429|502|503|504)(?:\D|$)|network|fetch failed|lock busy/i.test(
			msg,
		) || /secondary rate limit|exceeded a secondary rate|rate limit/i.test(msg)
	);
}

/** Max bytes of file content embedded via Create Tree `content` (keeps POST body bounded). */
export const MAX_INLINE_TREE_CONTENT_BYTES = 8 * 1024 * 1024;

/**
 * Min gap between Git blob POSTs. POST ≈ 5 secondary-rate points; 900 points/min
 * ⇒ ≤180 POSTs/min. 350ms keeps us under that ceiling even with retries.
 */
export const BLOB_POST_MIN_INTERVAL_MS = 350;

const GITHUB_MUTATION_MAX_ATTEMPTS = 6;

type TreeEntry =
	| {
			path: string;
			mode: "100644" | "100755";
			type: "blob";
			sha: string;
	  }
	| {
			path: string;
			mode: "100644" | "100755";
			type: "blob";
			content: string;
	  };

/** True when bytes are valid UTF-8 text with no NUL (safe for GitHub tree `content`). */
export function isUtf8Text(bytes: Uint8Array): boolean {
	if (bytes.length === 0) return true;
	for (let i = 0; i < bytes.length; i++) {
		if (bytes[i] === 0) return false;
	}
	try {
		new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
		return true;
	} catch {
		return false;
	}
}

/**
 * Prefer Create Tree `content` (1 POST for many files) over per-file Create Blob.
 * Binary / overflow files still use Create Blob, but throttled + retried so we
 * stay under GitHub's secondary rate limit (~900 points/min on a single endpoint).
 */
export function partitionFilesForTree(files: ExtractedFile[]): {
	inline: ExtractedFile[];
	needBlob: ExtractedFile[];
} {
	const inline: ExtractedFile[] = [];
	const needBlob: ExtractedFile[] = [];
	let inlineBytes = 0;

	for (const file of files) {
		const canInline =
			isUtf8Text(file.content) &&
			inlineBytes + file.content.byteLength <= MAX_INLINE_TREE_CONTENT_BYTES;
		if (canInline) {
			inline.push(file);
			inlineBytes += file.content.byteLength;
		} else {
			needBlob.push(file);
		}
	}
	return { inline, needBlob };
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

	const { inline, needBlob } = partitionFilesForTree(files);
	const treeEntries: TreeEntry[] = [];

	if (needBlob.length > 0) {
		const shas = await createBlobsThrottled(api, owner, repo, needBlob);
		for (let i = 0; i < needBlob.length; i++) {
			treeEntries.push({
				path: needBlob[i].path,
				mode: needBlob[i].mode,
				type: "blob",
				sha: shas[i],
			});
		}
	}

	const decoder = new TextDecoder("utf-8");
	for (const file of inline) {
		treeEntries.push({
			path: file.path,
			mode: file.mode,
			type: "blob",
			content: decoder.decode(file.content),
		});
	}

	// Full tree replace (no base_tree): archive contents become the branch snapshot.
	const treeRes = await githubFetchWithRetry(
		() =>
			api(`/repos/${owner}/${repo}/git/trees`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ tree: treeEntries }),
			}),
		"create tree",
	);
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

	const commitRes = await githubFetchWithRetry(
		() =>
			api(`/repos/${owner}/${repo}/git/commits`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					message,
					tree: treeData.sha,
					parents,
				}),
			}),
		"create commit",
	);
	const commitData = (await commitRes.json()) as { sha: string };

	if (parents.length === 0) {
		const createRef = await githubFetchWithRetry(
			() =>
				api(`/repos/${owner}/${repo}/git/refs`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						ref: `refs/heads/${branch}`,
						sha: commitData.sha,
					}),
				}),
			"create ref",
		);
		await createRef.arrayBuffer(); // drain body
	} else {
		const updateRef = await githubFetchWithRetry(
			() =>
				api(
					`/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(branch)}`,
					{
						method: "PATCH",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ sha: commitData.sha, force: false }),
					},
				),
			"update ref",
		);
		await updateRef.arrayBuffer();
	}

	return commitData.sha;
}

type GitHubApi = (path: string, init?: RequestInit) => Promise<Response>;

async function createBlobsThrottled(
	api: GitHubApi,
	owner: string,
	repo: string,
	files: ExtractedFile[],
): Promise<string[]> {
	const shas: string[] = [];
	let lastPostAt = 0;

	for (const file of files) {
		const wait = BLOB_POST_MIN_INTERVAL_MS - (Date.now() - lastPostAt);
		if (wait > 0) await sleep(wait);

		const res = await githubFetchWithRetry(async () => {
			lastPostAt = Date.now();
			return api(`/repos/${owner}/${repo}/git/blobs`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					content: bytesToBase64(file.content),
					encoding: "base64",
				}),
			});
		}, `create blob for '${file.path}'`);

		const data = (await res.json()) as { sha: string };
		shas.push(data.sha);
	}
	return shas;
}

async function githubFetchWithRetry(
	doFetch: () => Promise<Response>,
	label: string,
): Promise<Response> {
	let lastErr = "";
	for (let attempt = 1; attempt <= GITHUB_MUTATION_MAX_ATTEMPTS; attempt++) {
		const res = await doFetch();
		if (res.ok) return res;

		const body = await res.text();
		lastErr = `${label} failed: ${res.status} ${body}`;
		if (
			!isRetryableGitHubStatus(res.status, body) ||
			attempt === GITHUB_MUTATION_MAX_ATTEMPTS
		) {
			throw new Error(lastErr);
		}
		await sleep(retryDelayMs(res, attempt));
	}
	throw new Error(lastErr || `${label} failed`);
}

export function isRetryableGitHubStatus(status: number, body: string): boolean {
	if (status === 429 || status === 502 || status === 503 || status === 504) {
		return true;
	}
	// Secondary rate limits commonly surface as 403 with this wording.
	if (status === 403 && /rate limit|secondary rate/i.test(body)) {
		return true;
	}
	return false;
}

function retryDelayMs(res: Response, attempt: number): number {
	const retryAfter = res.headers.get("retry-after");
	if (retryAfter) {
		const asInt = Number(retryAfter);
		if (Number.isFinite(asInt) && asInt >= 0) {
			return Math.min(asInt * 1000, 60_000);
		}
		const asDate = Date.parse(retryAfter);
		if (Number.isFinite(asDate)) {
			return Math.min(Math.max(0, asDate - Date.now()), 60_000);
		}
	}
	const reset = res.headers.get("x-ratelimit-reset");
	if (reset) {
		const resetMs = Number(reset) * 1000;
		if (Number.isFinite(resetMs)) {
			const until = resetMs - Date.now();
			if (until > 0 && until < 60_000) return until;
		}
	}
	// Exponential backoff: 1s, 2s, 4s, … capped.
	return Math.min(1000 * 2 ** (attempt - 1), 30_000);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function bytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	const chunk = 0x8000;
	for (let i = 0; i < bytes.length; i += chunk) {
		binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
	}
	return btoa(binary);
}
