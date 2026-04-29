export const PATCH_FILES_TOOL = {
	name: "patch_files",
	description:
		"Apply targeted text edits to one or more existing files on a branch in a single atomic commit. " +
		"Each edit specifies an exact `old_text` that must appear EXACTLY ONCE in the current file, and " +
		"the `new_text` to replace it with. Include enough surrounding context in `old_text` to make it " +
		"unique — at least one full line is recommended. Whitespace and newlines in `old_text` must match " +
		"the file content character-for-character. All edits are applied together: if any one fails (file " +
		"not found, `old_text` not found, or matched multiple locations), no commit is made. Multiple " +
		"edits to the same file are applied in the order given, each operating on the result of the " +
		"previous one. Use `create_or_update_file` to create new files and `delete_file` to delete them — " +
		"this tool only edits existing files. The branch must already exist; create it with " +
		"`create_branch` first if needed.",
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
			edits: {
				type: "array",
				minItems: 1,
				description:
					"List of text replacements to apply. Each edit targets a single file and replaces a " +
					"unique occurrence of `old_text` with `new_text`. The same file may appear in multiple " +
					"edits; they are applied in order, each operating on the result of the previous one.",
				items: {
					type: "object",
					properties: {
						path: {
							type: "string",
							description: "Path of the file to edit, relative to the repo root.",
						},
						old_text: {
							type: "string",
							description:
								"Exact text to find in the current file. Must match a unique substring — " +
								"include surrounding context if the literal text appears multiple times. " +
								"Whitespace and newlines must match the file content character-for-character.",
						},
						new_text: {
							type: "string",
							description:
								"Replacement text. Use an empty string to delete the matched range.",
						},
					},
					required: ["path", "old_text", "new_text"],
				},
			},
		},
		required: ["owner", "repo", "branch", "message", "edits"],
	},
};

interface Edit {
	path: string;
	old_text: string;
	new_text: string;
}

interface PatchFilesArgs {
	owner?: unknown;
	repo?: unknown;
	branch?: unknown;
	message?: unknown;
	edits?: unknown;
}

interface ToolResult {
	content: { type: "text"; text: string }[];
	isError?: boolean;
}

interface TreeEntry {
	path: string;
	mode: "100644";
	type: "blob";
	sha: string;
}

export async function handlePatchFiles(
	args: PatchFilesArgs,
	accessToken: string,
): Promise<ToolResult> {
	const owner = typeof args.owner === "string" ? args.owner : "";
	const repo = typeof args.repo === "string" ? args.repo : "";
	const branch = typeof args.branch === "string" ? args.branch : "";
	const message = typeof args.message === "string" ? args.message : "";
	const editsRaw = Array.isArray(args.edits) ? args.edits : null;

	if (!owner || !repo || !branch || !message || !editsRaw) {
		return errorResult(
			"patch_files: missing required argument(s): owner, repo, branch, message, edits are all required.",
		);
	}
	if (editsRaw.length === 0) {
		return errorResult("patch_files: edits must contain at least one item.");
	}

	const edits: Edit[] = [];
	for (let i = 0; i < editsRaw.length; i++) {
		const e = editsRaw[i] as {
			path?: unknown;
			old_text?: unknown;
			new_text?: unknown;
		} | null;
		if (
			!e ||
			typeof e.path !== "string" ||
			typeof e.old_text !== "string" ||
			typeof e.new_text !== "string"
		) {
			return errorResult(
				`patch_files: edits[${i}] must have string fields path, old_text, new_text.`,
			);
		}
		if (e.path === "") {
			return errorResult(`patch_files: edits[${i}].path is empty.`);
		}
		if (e.old_text === "") {
			return errorResult(
				`patch_files: edits[${i}].old_text is empty. Use create_or_update_file to create new files.`,
			);
		}
		edits.push({ path: e.path, old_text: e.old_text, new_text: e.new_text });
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
			`patch_files: failed to fetch branch ref '${branch}': ${refRes.status} ${await refRes.text()}`,
		);
	}
	const refData = (await refRes.json()) as { object: { sha: string } };
	const baseCommitSha = refData.object.sha;

	const commitRes = await api(`/repos/${owner}/${repo}/git/commits/${baseCommitSha}`);
	if (!commitRes.ok) {
		return errorResult(
			`patch_files: failed to fetch base commit: ${commitRes.status} ${await commitRes.text()}`,
		);
	}
	const commitData = (await commitRes.json()) as { tree: { sha: string } };
	const baseTreeSha = commitData.tree.sha;

	// 2. Group edits by file (preserve order). For each file: fetch original,
	//    apply edits sequentially via single-occurrence string replace, create a blob.
	const editsByPath = new Map<string, Edit[]>();
	for (const e of edits) {
		const list = editsByPath.get(e.path) ?? [];
		list.push(e);
		editsByPath.set(e.path, list);
	}

	const treeEntries: TreeEntry[] = [];
	const summary: string[] = [];

	for (const [path, fileEdits] of editsByPath) {
		const fileRes = await api(
			`/repos/${owner}/${repo}/contents/${encodePath(path)}?ref=${encodeURIComponent(branch)}`,
		);
		if (fileRes.status === 404) {
			return errorResult(
				`patch_files: file '${path}' not found on branch '${branch}'. ` +
					"This tool only edits existing files; use create_or_update_file to create a new file.",
			);
		}
		if (!fileRes.ok) {
			return errorResult(
				`patch_files: failed to fetch '${path}': ${fileRes.status} ${await fileRes.text()}`,
			);
		}
		const fileData = (await fileRes.json()) as {
			content: string;
			encoding: string;
			type: string;
		};
		if (fileData.type !== "file") {
			return errorResult(
				`patch_files: '${path}' is not a regular file (type: ${fileData.type}).`,
			);
		}
		if (fileData.encoding !== "base64") {
			return errorResult(
				`patch_files: unsupported file encoding for '${path}': ${fileData.encoding}`,
			);
		}
		let content = base64ToUtf8(fileData.content.replace(/\n/g, ""));

		for (let i = 0; i < fileEdits.length; i++) {
			const edit = fileEdits[i];
			const occurrences = countOccurrences(content, edit.old_text);
			if (occurrences === 0) {
				return errorResult(
					`patch_files: edit #${i + 1} for '${path}': old_text not found in current file content. ` +
						"Whitespace and newlines must match exactly. Re-fetch the file with get_file_contents " +
						"to see its current state.",
				);
			}
			if (occurrences > 1) {
				return errorResult(
					`patch_files: edit #${i + 1} for '${path}': old_text matched ${occurrences} locations. ` +
						"Include more surrounding context in old_text so it identifies exactly one location.",
				);
			}
			const idx = content.indexOf(edit.old_text);
			content =
				content.slice(0, idx) + edit.new_text + content.slice(idx + edit.old_text.length);
		}

		const blobRes = await api(`/repos/${owner}/${repo}/git/blobs`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				content: utf8ToBase64(content),
				encoding: "base64",
			}),
		});
		if (!blobRes.ok) {
			return errorResult(
				`patch_files: failed to create blob for '${path}': ${blobRes.status} ${await blobRes.text()}`,
			);
		}
		const blobData = (await blobRes.json()) as { sha: string };
		treeEntries.push({
			path,
			mode: "100644",
			type: "blob",
			sha: blobData.sha,
		});
		summary.push(
			`  patched: ${path} (${fileEdits.length} edit${fileEdits.length === 1 ? "" : "s"})`,
		);
	}

	// 3. Build a new tree on top of the base tree.
	const treeRes = await api(`/repos/${owner}/${repo}/git/trees`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ base_tree: baseTreeSha, tree: treeEntries }),
	});
	if (!treeRes.ok) {
		return errorResult(
			`patch_files: failed to create tree: ${treeRes.status} ${await treeRes.text()}`,
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
			`patch_files: failed to create commit: ${newCommitRes.status} ${await newCommitRes.text()}`,
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
			`patch_files: failed to update branch ref: ${updateRefRes.status} ${await updateRefRes.text()}`,
		);
	}

	return {
		content: [
			{
				type: "text",
				text:
					`Successfully applied ${edits.length} edit(s) across ${treeEntries.length} file(s) on '${branch}'.\n` +
					`Commit: ${newCommitData.sha}\n${summary.join("\n")}`,
			},
		],
	};
}

function countOccurrences(haystack: string, needle: string): number {
	if (needle === "") return 0;
	let count = 0;
	let pos = 0;
	while (true) {
		const found = haystack.indexOf(needle, pos);
		if (found === -1) break;
		count++;
		pos = found + needle.length;
	}
	return count;
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
