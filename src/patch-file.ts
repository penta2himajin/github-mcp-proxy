import { applyPatch, parsePatch, type StructuredPatch } from "diff";

export const PATCH_FILE_TOOL = {
	name: "patch_file",
	description:
		"Apply a unified diff patch to one or more files on a branch in a single commit. " +
		"The diff must be in unified diff format (e.g. output of `git diff` or `diff -u`); " +
		"multiple files can be patched in one call by including multiple file sections in the diff. " +
		"Use this instead of `create_or_update_file` when you only need targeted edits and want to " +
		"avoid sending the full file content. The branch must already exist — create it with " +
		"`create_branch` first if needed. All patches are applied atomically: if any patch fails to " +
		"apply cleanly, no commit is made. Supports new files (with `--- /dev/null` header) and " +
		"deletions (with `+++ /dev/null` header).",
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
				description: "Branch to commit to (must already exist)",
			},
			message: { type: "string", description: "Commit message" },
			diff: {
				type: "string",
				description:
					"Unified diff to apply. May contain patches for multiple files. " +
					"Standard `a/` and `b/` path prefixes are stripped automatically.",
			},
		},
		required: ["owner", "repo", "branch", "message", "diff"],
	},
};

interface PatchFileArgs {
	owner?: unknown;
	repo?: unknown;
	branch?: unknown;
	message?: unknown;
	diff?: unknown;
}

interface ToolResult {
	content: { type: "text"; text: string }[];
	isError?: boolean;
}

interface TreeEntry {
	path: string;
	mode: "100644";
	type: "blob";
	sha: string | null;
}

export async function handlePatchFile(
	args: PatchFileArgs,
	accessToken: string,
): Promise<ToolResult> {
	const owner = typeof args.owner === "string" ? args.owner : "";
	const repo = typeof args.repo === "string" ? args.repo : "";
	const branch = typeof args.branch === "string" ? args.branch : "";
	const message = typeof args.message === "string" ? args.message : "";
	const diff = typeof args.diff === "string" ? args.diff : "";

	if (!owner || !repo || !branch || !message || !diff) {
		return errorResult(
			"patch_file: missing required argument(s): owner, repo, branch, message, diff are all required.",
		);
	}

	let patches: StructuredPatch[];
	try {
		patches = parsePatch(diff);
	} catch (e: any) {
		return errorResult(`patch_file: failed to parse diff: ${e?.message ?? e}`);
	}
	if (patches.length === 0) {
		return errorResult("patch_file: no file patches found in diff.");
	}

	const api = (path: string, init?: RequestInit) =>
		fetch(`https://api.github.com${path}`, {
			...init,
			headers: {
				Authorization: `Bearer ${accessToken}`,
				Accept: "application/vnd.github+json",
				"User-Agent": "github-mcp-proxy",
				...(init?.headers ?? {}),
			},
		});

	// 1. Resolve the branch ref → base commit SHA → base tree SHA.
	const refRes = await api(
		`/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(branch)}`,
	);
	if (!refRes.ok) {
		return errorResult(
			`patch_file: failed to fetch branch ref '${branch}': ${refRes.status} ${await refRes.text()}`,
		);
	}
	const refData = (await refRes.json()) as { object: { sha: string } };
	const baseCommitSha = refData.object.sha;

	const commitRes = await api(`/repos/${owner}/${repo}/git/commits/${baseCommitSha}`);
	if (!commitRes.ok) {
		return errorResult(
			`patch_file: failed to fetch base commit: ${commitRes.status} ${await commitRes.text()}`,
		);
	}
	const commitData = (await commitRes.json()) as { tree: { sha: string } };
	const baseTreeSha = commitData.tree.sha;

	// 2. For each file patch: fetch the original (if any), apply the patch, create a blob.
	const treeEntries: TreeEntry[] = [];
	for (const patch of patches) {
		const oldRaw = patch.oldFileName ?? "";
		const newRaw = patch.newFileName ?? "";
		const oldPath = stripDiffPrefix(oldRaw);
		const newPath = stripDiffPrefix(newRaw);
		const isCreation = oldRaw === "/dev/null";
		const isDeletion = newRaw === "/dev/null";

		if (isDeletion) {
			if (!oldPath) {
				return errorResult("patch_file: deletion patch is missing source path.");
			}
			treeEntries.push({ path: oldPath, mode: "100644", type: "blob", sha: null });
			continue;
		}

		const targetPath = newPath || oldPath;
		if (!targetPath) {
			return errorResult("patch_file: patch is missing file path.");
		}

		let originalContent = "";
		if (!isCreation && oldPath) {
			const fileRes = await api(
				`/repos/${owner}/${repo}/contents/${encodePath(oldPath)}?ref=${encodeURIComponent(branch)}`,
			);
			if (fileRes.ok) {
				const fileData = (await fileRes.json()) as {
					content: string;
					encoding: string;
					type: string;
				};
				if (fileData.type !== "file") {
					return errorResult(
						`patch_file: '${oldPath}' is not a regular file (type: ${fileData.type}).`,
					);
				}
				if (fileData.encoding !== "base64") {
					return errorResult(
						`patch_file: unsupported file encoding for '${oldPath}': ${fileData.encoding}`,
					);
				}
				originalContent = base64ToUtf8(fileData.content.replace(/\n/g, ""));
			} else if (fileRes.status === 404) {
				originalContent = "";
			} else {
				return errorResult(
					`patch_file: failed to fetch '${oldPath}': ${fileRes.status} ${await fileRes.text()}`,
				);
			}
		}

		const patched = applyPatch(originalContent, patch);
		if (patched === false) {
			return errorResult(
				`patch_file: patch failed to apply cleanly to '${targetPath}'. ` +
					"The diff context may be stale; re-fetch the file and regenerate the diff.",
			);
		}

		const blobRes = await api(`/repos/${owner}/${repo}/git/blobs`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				content: utf8ToBase64(patched),
				encoding: "base64",
			}),
		});
		if (!blobRes.ok) {
			return errorResult(
				`patch_file: failed to create blob for '${targetPath}': ${blobRes.status} ${await blobRes.text()}`,
			);
		}
		const blobData = (await blobRes.json()) as { sha: string };
		treeEntries.push({
			path: targetPath,
			mode: "100644",
			type: "blob",
			sha: blobData.sha,
		});
	}

	// 3. Build a new tree on top of the base tree.
	const treeRes = await api(`/repos/${owner}/${repo}/git/trees`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ base_tree: baseTreeSha, tree: treeEntries }),
	});
	if (!treeRes.ok) {
		return errorResult(
			`patch_file: failed to create tree: ${treeRes.status} ${await treeRes.text()}`,
		);
	}
	const treeData = (await treeRes.json()) as { sha: string };

	// 4. Create the commit pointing at the new tree.
	const newCommitRes = await api(`/repos/${owner}/${repo}/git/commits`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			message,
			tree: treeData.sha,
			parents: [baseCommitSha],
		}),
	});
	if (!newCommitRes.ok) {
		return errorResult(
			`patch_file: failed to create commit: ${newCommitRes.status} ${await newCommitRes.text()}`,
		);
	}
	const newCommitData = (await newCommitRes.json()) as { sha: string };

	// 5. Fast-forward the branch ref.
	const updateRefRes = await api(
		`/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(branch)}`,
		{
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ sha: newCommitData.sha, force: false }),
		},
	);
	if (!updateRefRes.ok) {
		return errorResult(
			`patch_file: failed to update branch ref: ${updateRefRes.status} ${await updateRefRes.text()}`,
		);
	}

	const summary = treeEntries
		.map((e) => `  ${e.sha === null ? "deleted" : "patched"}: ${e.path}`)
		.join("\n");
	return {
		content: [
			{
				type: "text",
				text:
					`Successfully applied patch to ${treeEntries.length} file(s) on '${branch}'.\n` +
					`Commit: ${newCommitData.sha}\n${summary}`,
			},
		],
	};
}

function stripDiffPrefix(name: string): string {
	if (name === "/dev/null") return "";
	if (name.startsWith("a/") || name.startsWith("b/")) return name.slice(2);
	return name;
}

function encodePath(path: string): string {
	return path.split("/").map(encodeURIComponent).join("/");
}

function utf8ToBase64(s: string): string {
	const bytes = new TextEncoder().encode(s);
	let binary = "";
	for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
	return btoa(binary);
}

function base64ToUtf8(b64: string): string {
	const binary = atob(b64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return new TextDecoder().decode(bytes);
}

function errorResult(text: string): ToolResult {
	return { content: [{ type: "text", text }], isError: true };
}
