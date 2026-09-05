/** Shared session model for archive upload → GitHub commit flow. */

export const ARCHIVE_UPLOAD_KEY_PREFIX = "archive-uploads/";
export const ARCHIVE_UPLOAD_KV_PREFIX = "archive-upload:";

/** Default lifetime of the presigned PUT URL (seconds). */
export const DEFAULT_UPLOAD_TTL_SECONDS = 900;

/** KV/session retention beyond the upload URL, so status can still be queried. */
export const SESSION_TTL_PADDING_SECONDS = 900;

/** Soft limits enforced when expanding an archive. */
export const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024;
export const MAX_EXTRACTED_BYTES = 100 * 1024 * 1024;
export const MAX_FILE_COUNT = 1000;
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

/** Human-readable summary of limits for tool docs / client guidance. */
export function formatArchiveUploadLimits(): string {
	return (
		`zip ≤ ${formatMiB(MAX_ARCHIVE_BYTES)}, ` +
		`extracted total ≤ ${formatMiB(MAX_EXTRACTED_BYTES)}, ` +
		`≤ ${MAX_FILE_COUNT} files, ` +
		`each file ≤ ${formatMiB(MAX_FILE_BYTES)}`
	);
}

function formatMiB(bytes: number): string {
	const mib = bytes / (1024 * 1024);
	const text = Number.isInteger(mib) ? String(mib) : mib.toFixed(1);
	return `${text} MiB`;
}

export type ArchiveUploadStatus =
	| "awaiting_upload"
	| "processing"
	| "committed"
	| "failed";

export type ArchiveFormat = "zip";

export interface ArchiveUploadSession {
	upload_id: string;
	/** R2 object key for the archive body (not the lock object). */
	object_key: string;
	owner: string;
	repo: string;
	branch: string;
	message: string;
	format: ArchiveFormat;
	status: ArchiveUploadStatus;
	/** GitHub user access token; kept only for the session TTL. */
	access_token: string;
	created_at: string;
	expires_at: string;
	/** GitHub login of the user who created the session (audit). */
	created_by: string;
	commit_sha?: string;
	error?: string;
	/** eTag of the object that was successfully committed (queue dedupe). */
	committed_etag?: string;
	/** How many object-create events were ignored after the first commit. */
	ignored_duplicate_uploads: number;
	processed_event_ids: string[];
}

export function sessionKvKey(uploadId: string): string {
	return `${ARCHIVE_UPLOAD_KV_PREFIX}${uploadId}`;
}

export function archiveObjectKey(uploadId: string, format: ArchiveFormat): string {
	const ext = format === "zip" ? "zip" : "zip";
	return `${ARCHIVE_UPLOAD_KEY_PREFIX}${uploadId}/archive.${ext}`;
}

export function lockObjectKey(uploadId: string): string {
	return `${ARCHIVE_UPLOAD_KEY_PREFIX}${uploadId}/.lock`;
}

/** Parse `archive-uploads/{upload_id}/archive.zip` → upload_id, or null. */
export function uploadIdFromObjectKey(key: string): string | null {
	const prefix = ARCHIVE_UPLOAD_KEY_PREFIX;
	if (!key.startsWith(prefix)) return null;
	if (key.endsWith("/.lock")) return null;
	const rest = key.slice(prefix.length);
	const slash = rest.indexOf("/");
	if (slash <= 0) return null;
	const uploadId = rest.slice(0, slash);
	const filename = rest.slice(slash + 1);
	if (!uploadId || !filename.startsWith("archive.")) return null;
	return uploadId;
}

export function buildStatusPayload(session: ArchiveUploadSession): Record<string, unknown> {
	const reflected = session.status === "committed";
	const parts: string[] = [];

	if (session.status === "awaiting_upload") {
		parts.push("Waiting for archive upload (presigned PUT).");
	} else if (session.status === "processing") {
		parts.push("Upload received; committing to GitHub.");
	} else if (session.status === "committed") {
		parts.push(
			`Committed to ${session.owner}/${session.repo}@${session.branch}` +
				(session.commit_sha ? ` (${session.commit_sha})` : "") +
				".",
		);
	} else if (session.status === "failed") {
		parts.push(`Failed: ${session.error ?? "unknown error"}`);
	}

	if (session.ignored_duplicate_uploads > 0) {
		parts.push(
			`Storage accepted ${session.ignored_duplicate_uploads} subsequent upload(s), ` +
				"but they were not reflected to GitHub (one-shot session).",
		);
	}

	return {
		upload_id: session.upload_id,
		status: session.status,
		reflected,
		owner: session.owner,
		repo: session.repo,
		branch: session.branch,
		format: session.format,
		commit_sha: session.commit_sha ?? null,
		error: session.error ?? null,
		ignored_duplicate_uploads: session.ignored_duplicate_uploads,
		expires_at: session.expires_at,
		message: parts.join(" "),
	};
}
