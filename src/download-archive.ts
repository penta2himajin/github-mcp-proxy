export const DOWNLOAD_ARCHIVE_TOOL = {
	name: "download_repository_archive",
	description:
		"Get a temporary, signed download URL for a repository archive (zip or tar.gz) via the GitHub " +
		"archive API. Works for private repositories because the request is authenticated with the user's " +
		"token. The tool follows the archive endpoint's redirect and returns the resulting " +
		"`codeload.github.com` URL, which is short-lived (valid for roughly a few minutes) and can be " +
		"downloaded without any additional authentication — the GitHub token is NOT embedded in the URL. " +
		"Use `ref` to pick a branch, tag, or commit SHA; when omitted, the repository's default branch is " +
		"used. This does not clone into the local filesystem; it returns a URL you (or a downstream tool) " +
		"can fetch the archive from.",
	inputSchema: {
		type: "object",
		properties: {
			owner: {
				type: "string",
				description: "Repository owner (username or organization)",
			},
			repo: { type: "string", description: "Repository name" },
			ref: {
				type: "string",
				description:
					"Branch, tag, or commit SHA to archive. Omit to use the repository's default branch.",
			},
			format: {
				type: "string",
				enum: ["zip", "tar.gz"],
				description:
					"Archive format: 'zip' (default, uses the zipball endpoint) or 'tar.gz' (uses the tarball endpoint).",
			},
		},
		required: ["owner", "repo"],
	},
};

interface DownloadArchiveArgs {
	owner?: unknown;
	repo?: unknown;
	ref?: unknown;
	format?: unknown;
}

interface ToolResult {
	content: { type: "text"; text: string }[];
	isError?: boolean;
}

export async function handleDownloadArchive(
	args: DownloadArchiveArgs,
	accessToken: string,
): Promise<ToolResult> {
	const owner = typeof args.owner === "string" ? args.owner : "";
	const repo = typeof args.repo === "string" ? args.repo : "";
	const ref = typeof args.ref === "string" ? args.ref : "";

	if (!owner || !repo) {
		return errorResult(
			"download_repository_archive: missing required argument(s): owner and repo are required.",
		);
	}

	let format: "zip" | "tar.gz";
	if (args.format === undefined || args.format === "zip") {
		format = "zip";
	} else if (args.format === "tar.gz") {
		format = "tar.gz";
	} else {
		return errorResult(
			`download_repository_archive: invalid format '${String(args.format)}'. Use 'zip' or 'tar.gz'.`,
		);
	}

	const endpoint = format === "zip" ? "zipball" : "tarball";
	// The archive endpoints accept an optional ref as a trailing path segment.
	// Refs may contain slashes (e.g. `feature/x`), so encode each segment but
	// keep the separators intact.
	const refPath = ref ? `/${encodeRef(ref)}` : "";
	const url = `https://api.github.com/repos/${owner}/${repo}/${endpoint}${refPath}`;

	let res: Response;
	try {
		res = await fetch(url, {
			// Capture the redirect ourselves so we can hand back the signed
			// codeload URL instead of streaming the (potentially huge) archive
			// body through the Worker.
			redirect: "manual",
			headers: {
				Authorization: `Bearer ${accessToken}`,
				Accept: "application/vnd.github+json",
				"User-Agent": "github-mcp-proxy",
			},
		});
	} catch (e) {
		return errorResult(
			`download_repository_archive: request to GitHub failed: ${String(e)}`,
		);
	}

	if (res.status >= 300 && res.status < 400) {
		const location = res.headers.get("Location");
		if (!location) {
			return errorResult(
				`download_repository_archive: GitHub returned a ${res.status} redirect without a Location header.`,
			);
		}
		const refLabel = ref || "(default branch)";
		return {
			content: [
				{
					type: "text",
					text:
						`Archive download URL for ${owner}/${repo} @ ${refLabel} (${format}):\n` +
						`${location}\n\n` +
						"This URL is temporary (valid for roughly a few minutes) and requires no further " +
						"authentication. Fetch it to download the archive.",
				},
			],
		};
	}

	if (res.status === 404) {
		return errorResult(
			`download_repository_archive: repository '${owner}/${repo}'` +
				(ref ? ` or ref '${ref}'` : "") +
				" not found, or the token lacks access.",
		);
	}

	return errorResult(
		`download_repository_archive: unexpected response from GitHub: ${res.status} ${await safeText(res)}`,
	);
}

function encodeRef(ref: string): string {
	return ref.split("/").map(encodeURIComponent).join("/");
}

async function safeText(res: Response): Promise<string> {
	try {
		return await res.text();
	} catch {
		return "";
	}
}

function errorResult(text: string): ToolResult {
	return { content: [{ type: "text", text }], isError: true };
}
