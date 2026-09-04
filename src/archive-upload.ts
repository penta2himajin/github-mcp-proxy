import { AwsClient } from "aws4fetch";
import {
	ARCHIVE_UPLOAD_KEY_PREFIX,
	ArchiveFormat,
	ArchiveUploadSession,
	DEFAULT_UPLOAD_TTL_SECONDS,
	SESSION_TTL_PADDING_SECONDS,
	archiveObjectKey,
	buildStatusPayload,
	sessionKvKey,
} from "./archive-upload-session";

export const CREATE_ARCHIVE_UPLOAD_TOOL = {
	name: "create_archive_upload",
	description:
		"Start a one-shot archive upload that will be expanded and committed to a GitHub " +
		"repository branch. Returns a short-lived R2 presigned PUT URL. Upload the zip with " +
		"`curl -X PUT \"$upload_url\" --data-binary @archive.zip`, then poll " +
		"`get_archive_upload_status` (or GET the returned status_url) until status is " +
		"`committed` or `failed`. Detection is event-driven (R2 object-create → Queue): you do " +
		"not call a separate commit tool. Each upload_id is one-shot — a later PUT to the same " +
		"URL may succeed at storage level but will NOT be reflected to GitHub; status will show " +
		"`ignored_duplicate_uploads` and `reflected` stays based on the first successful commit. " +
		"To push again, create a new upload session. Currently only `zip` is supported.",
	inputSchema: {
		type: "object",
		properties: {
			owner: {
				type: "string",
				description: "Repository owner (username or organization)",
			},
			repo: { type: "string", description: "Repository name" },
			branch: {
				type: "string",
				description:
					"Branch to commit to. Created as a root commit target if the repo/branch has no commits yet.",
			},
			message: { type: "string", description: "Commit message for the imported archive" },
			format: {
				type: "string",
				enum: ["zip"],
				description: "Archive format. Only 'zip' is supported currently (default: zip).",
			},
		},
		required: ["owner", "repo", "branch", "message"],
	},
};

export const GET_ARCHIVE_UPLOAD_STATUS_TOOL = {
	name: "get_archive_upload_status",
	description:
		"Get the status of an archive upload session created by create_archive_upload. " +
		"Use this after PUTting the archive (or while waiting for the queue consumer). " +
		"Returns whether the archive was reflected to GitHub (`reflected`), the commit SHA " +
		"when committed, and whether later storage uploads were ignored " +
		"(`ignored_duplicate_uploads`). R2's PUT response cannot itself signal " +
		"non-reflection — this status (or the HTTP status_url) is the source of truth.",
	inputSchema: {
		type: "object",
		properties: {
			upload_id: {
				type: "string",
				description: "Upload session id returned by create_archive_upload",
			},
		},
		required: ["upload_id"],
	},
};

interface ToolResult {
	content: { type: "text"; text: string }[];
	isError?: boolean;
}

interface CreateArgs {
	owner?: unknown;
	repo?: unknown;
	branch?: unknown;
	message?: unknown;
	format?: unknown;
}

interface StatusArgs {
	upload_id?: unknown;
}

export interface ArchiveUploadEnv {
	OAUTH_KV: KVNamespace;
	ARCHIVE_UPLOADS: R2Bucket;
	R2_ACCOUNT_ID: string;
	R2_ACCESS_KEY_ID: string;
	R2_SECRET_ACCESS_KEY: string;
	R2_BUCKET_NAME: string;
	ARCHIVE_UPLOAD_TTL_SECONDS?: string;
}

export async function handleCreateArchiveUpload(
	args: CreateArgs,
	accessToken: string,
	createdBy: string,
	env: ArchiveUploadEnv,
	publicOrigin: string,
): Promise<ToolResult> {
	const owner = typeof args.owner === "string" ? args.owner.trim() : "";
	const repo = typeof args.repo === "string" ? args.repo.trim() : "";
	const branch = typeof args.branch === "string" ? args.branch.trim() : "";
	const message = typeof args.message === "string" ? args.message : "";

	if (!owner || !repo || !branch || !message) {
		return errorResult(
			"create_archive_upload: missing required argument(s): owner, repo, branch, and message are required.",
		);
	}

	let format: ArchiveFormat;
	if (args.format === undefined || args.format === "zip") {
		format = "zip";
	} else {
		return errorResult(
			`create_archive_upload: invalid format '${String(args.format)}'. Only 'zip' is supported currently.`,
		);
	}

	const missing = missingR2Config(env);
	if (missing.length > 0) {
		return errorResult(
			`create_archive_upload: server missing R2 configuration: ${missing.join(", ")}. ` +
				"Set secrets/vars and bind the ARCHIVE_UPLOADS bucket (see README).",
		);
	}

	const ttlSeconds = parseTtl(env.ARCHIVE_UPLOAD_TTL_SECONDS);
	const uploadId = crypto.randomUUID();
	const objectKey = archiveObjectKey(uploadId, format);
	const now = new Date();
	const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);

	let uploadUrl: string;
	try {
		uploadUrl = await createPresignedPutUrl(env, objectKey, ttlSeconds);
	} catch (e) {
		return errorResult(
			`create_archive_upload: failed to sign upload URL: ${String(e)}`,
		);
	}

	const session: ArchiveUploadSession = {
		upload_id: uploadId,
		object_key: objectKey,
		owner,
		repo,
		branch,
		message,
		format,
		status: "awaiting_upload",
		access_token: accessToken,
		created_at: now.toISOString(),
		expires_at: expiresAt.toISOString(),
		created_by: createdBy,
		ignored_duplicate_uploads: 0,
		processed_event_ids: [],
	};

	const sessionTtl = ttlSeconds + SESSION_TTL_PADDING_SECONDS;
	await env.OAUTH_KV.put(sessionKvKey(uploadId), JSON.stringify(session), {
		expirationTtl: sessionTtl,
	});

	const statusUrl = `${publicOrigin.replace(/\/$/, "")}/archive-uploads/${uploadId}`;

	return {
		content: [
			{
				type: "text",
				text:
					`Archive upload session created.\n` +
					`upload_id: ${uploadId}\n` +
					`target: ${owner}/${repo}@${branch}\n` +
					`format: ${format}\n` +
					`expires_at: ${expiresAt.toISOString()}\n` +
					`upload_url: ${uploadUrl}\n` +
					`status_url: ${statusUrl}\n\n` +
					`Upload with:\n` +
					`  curl -X PUT "$upload_url" --data-binary @archive.zip\n\n` +
					`Then poll status:\n` +
					`  get_archive_upload_status upload_id=${uploadId}\n` +
					`  # or: curl "$status_url"\n\n` +
					`This session is one-shot. A later PUT may still return HTTP 200 from R2, but ` +
					`will not be reflected to GitHub — check status for ignored_duplicate_uploads / reflected.`,
			},
		],
	};
}

export async function handleGetArchiveUploadStatus(
	args: StatusArgs,
	env: Pick<ArchiveUploadEnv, "OAUTH_KV">,
): Promise<ToolResult> {
	const uploadId = typeof args.upload_id === "string" ? args.upload_id.trim() : "";
	if (!uploadId) {
		return errorResult(
			"get_archive_upload_status: missing required argument: upload_id.",
		);
	}

	const raw = await env.OAUTH_KV.get(sessionKvKey(uploadId));
	if (!raw) {
		return errorResult(
			`get_archive_upload_status: upload_id '${uploadId}' not found or expired.`,
		);
	}

	let session: ArchiveUploadSession;
	try {
		session = JSON.parse(raw) as ArchiveUploadSession;
	} catch {
		return errorResult(
			"get_archive_upload_status: corrupt session record in KV.",
		);
	}

	// Never leak the access token in status output.
	const payload = buildStatusPayload(session);
	return {
		content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
	};
}

/** HTTP GET /archive-uploads/:id — JSON status for curl clients (no token in body). */
export async function handleArchiveUploadStatusHttp(
	uploadId: string,
	env: Pick<ArchiveUploadEnv, "OAUTH_KV">,
): Promise<Response> {
	const raw = await env.OAUTH_KV.get(sessionKvKey(uploadId));
	if (!raw) {
		return jsonResponse(
			{ error: "not_found", message: "upload_id not found or expired" },
			404,
		);
	}
	try {
		const session = JSON.parse(raw) as ArchiveUploadSession;
		return jsonResponse(buildStatusPayload(session), 200);
	} catch {
		return jsonResponse({ error: "corrupt_session" }, 500);
	}
}

export function isArchiveUploadStatusPath(pathname: string): string | null {
	const m = pathname.match(/^\/archive-uploads\/([^/]+)\/?$/);
	return m ? decodeURIComponent(m[1]) : null;
}

async function createPresignedPutUrl(
	env: ArchiveUploadEnv,
	objectKey: string,
	ttlSeconds: number,
): Promise<string> {
	const client = new AwsClient({
		accessKeyId: env.R2_ACCESS_KEY_ID,
		secretAccessKey: env.R2_SECRET_ACCESS_KEY,
		service: "s3",
		region: "auto",
	});

	const url = new URL(
		`https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.R2_BUCKET_NAME}/${objectKey}`,
	);
	url.searchParams.set("X-Amz-Expires", String(ttlSeconds));

	const signed = await client.sign(
		new Request(url.toString(), { method: "PUT" }),
		{ aws: { signQuery: true } },
	);
	return signed.url.toString();
}

function parseTtl(raw: string | undefined): number {
	if (!raw) return DEFAULT_UPLOAD_TTL_SECONDS;
	const n = Number(raw);
	if (!Number.isFinite(n) || n < 60 || n > 604800) {
		return DEFAULT_UPLOAD_TTL_SECONDS;
	}
	return Math.floor(n);
}

function missingR2Config(env: ArchiveUploadEnv): string[] {
	const missing: string[] = [];
	if (!env.ARCHIVE_UPLOADS) missing.push("ARCHIVE_UPLOADS (R2 binding)");
	if (!env.R2_ACCOUNT_ID) missing.push("R2_ACCOUNT_ID");
	if (!env.R2_ACCESS_KEY_ID) missing.push("R2_ACCESS_KEY_ID");
	if (!env.R2_SECRET_ACCESS_KEY) missing.push("R2_SECRET_ACCESS_KEY");
	if (!env.R2_BUCKET_NAME) missing.push("R2_BUCKET_NAME");
	if (!env.OAUTH_KV) missing.push("OAUTH_KV");
	return missing;
}

function jsonResponse(body: unknown, status: number): Response {
	return new Response(JSON.stringify(body, null, 2), {
		status,
		headers: { "Content-Type": "application/json; charset=utf-8" },
	});
}

function errorResult(text: string): ToolResult {
	return { content: [{ type: "text", text }], isError: true };
}

// Re-export prefix for docs/tests.
export { ARCHIVE_UPLOAD_KEY_PREFIX };
