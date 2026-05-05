import { afterEach, describe, expect, it, vi } from "vitest";
import { handlePatchFiles, PATCH_FILES_TOOL } from "./patch-files";

const TOKEN = "ghs_test_token";

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function contentsResponse(text: string): Response {
	const b64 = Buffer.from(text, "utf-8").toString("base64");
	return jsonResponse({ type: "file", encoding: "base64", content: b64 });
}

function expectErrorResult(
	result: Awaited<ReturnType<typeof handlePatchFiles>>,
	matcher: RegExp,
) {
	expect(result.isError).toBe(true);
	expect(result.content[0]?.text).toMatch(matcher);
}

describe("PATCH_FILES_TOOL schema", () => {
	it("declares the required top-level fields", () => {
		expect(PATCH_FILES_TOOL.name).toBe("patch_files");
		expect(PATCH_FILES_TOOL.inputSchema.required).toEqual([
			"owner",
			"repo",
			"branch",
			"message",
			"edits",
		]);
		expect(PATCH_FILES_TOOL.inputSchema.properties.edits.minItems).toBe(1);
	});
});

describe("handlePatchFiles - argument validation", () => {
	const validBase = {
		owner: "o",
		repo: "r",
		branch: "main",
		message: "msg",
	};

	it("rejects missing required arguments", async () => {
		const result = await handlePatchFiles({}, TOKEN);
		expectErrorResult(result, /missing required argument/i);
	});

	it("rejects empty edits array", async () => {
		const result = await handlePatchFiles({ ...validBase, edits: [] }, TOKEN);
		expectErrorResult(result, /at least one item/i);
	});

	it("rejects edits with non-string fields", async () => {
		const result = await handlePatchFiles(
			{ ...validBase, edits: [{ path: "a.txt", old_text: 1, new_text: "x" }] },
			TOKEN,
		);
		expectErrorResult(result, /edits\[0\] must have string fields/);
	});

	it("rejects edits with empty path", async () => {
		const result = await handlePatchFiles(
			{ ...validBase, edits: [{ path: "", old_text: "a", new_text: "b" }] },
			TOKEN,
		);
		expectErrorResult(result, /edits\[0\]\.path is empty/);
	});

	it("rejects edits with empty old_text", async () => {
		const result = await handlePatchFiles(
			{ ...validBase, edits: [{ path: "a.txt", old_text: "", new_text: "b" }] },
			TOKEN,
		);
		expectErrorResult(result, /old_text is empty/);
	});

	it("does not call the GitHub API for invalid input", async () => {
		const fetchMock = vi.spyOn(globalThis, "fetch");
		await handlePatchFiles({}, TOKEN);
		expect(fetchMock).not.toHaveBeenCalled();
		fetchMock.mockRestore();
	});
});

describe("handlePatchFiles - GitHub API flow", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	const validBase = {
		owner: "o",
		repo: "r",
		branch: "main",
		message: "msg",
	};

	function mockHappyPath(opts: {
		fileContent: string;
		newCommitSha?: string;
	}) {
		const newCommitSha = opts.newCommitSha ?? "newcommit";
		return vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(jsonResponse({ object: { sha: "basecommit" } })) // ref
			.mockResolvedValueOnce(jsonResponse({ tree: { sha: "basetree" } })) // commit
			.mockResolvedValueOnce(contentsResponse(opts.fileContent)) // contents
			.mockResolvedValueOnce(jsonResponse({ sha: "blob1" })) // blob
			.mockResolvedValueOnce(jsonResponse({ sha: "newtree" })) // tree
			.mockResolvedValueOnce(jsonResponse({ sha: newCommitSha })) // commit
			.mockResolvedValueOnce(jsonResponse({ ref: `refs/heads/main` })); // ref update
	}

	it("applies a single edit and reports the new commit", async () => {
		const fetchMock = mockHappyPath({
			fileContent: "hello world\n",
			newCommitSha: "abc123",
		});

		const result = await handlePatchFiles(
			{
				...validBase,
				edits: [{ path: "README.md", old_text: "hello", new_text: "hi" }],
			},
			TOKEN,
		);

		expect(result.isError).toBeUndefined();
		expect(result.content[0]?.text).toContain("Commit: abc123");
		expect(result.content[0]?.text).toContain("patched: README.md (1 edit)");

		expect(fetchMock).toHaveBeenCalledTimes(7);

		const callArgs = fetchMock.mock.calls;
		expect(callArgs[0][0]).toBe(
			"https://api.github.com/repos/o/r/git/refs/heads/main",
		);
		expect(callArgs[2][0]).toBe(
			"https://api.github.com/repos/o/r/contents/README.md?ref=main",
		);

		const blobInit = callArgs[3][1] as RequestInit;
		expect(blobInit.method).toBe("POST");
		const blobBody = JSON.parse(blobInit.body as string) as {
			content: string;
			encoding: string;
		};
		expect(blobBody.encoding).toBe("base64");
		expect(Buffer.from(blobBody.content, "base64").toString("utf-8")).toBe(
			"hi world\n",
		);

		const refUpdateInit = callArgs[6][1] as RequestInit;
		expect(refUpdateInit.method).toBe("PATCH");
		expect(JSON.parse(refUpdateInit.body as string)).toEqual({
			sha: "abc123",
			force: false,
		});

		for (const [, init] of callArgs) {
			const headers = (init as RequestInit | undefined)?.headers as
				| Record<string, string>
				| undefined;
			expect(headers?.Authorization).toBe(`Bearer ${TOKEN}`);
			expect(headers?.["User-Agent"]).toBe("github-mcp-proxy");
		}
	});

	it("applies sequential edits to the same file", async () => {
		const fetchMock = mockHappyPath({
			fileContent: "alpha beta gamma\n",
		});

		const result = await handlePatchFiles(
			{
				...validBase,
				edits: [
					{ path: "f.txt", old_text: "alpha", new_text: "ALPHA" },
					{ path: "f.txt", old_text: "beta", new_text: "BETA" },
				],
			},
			TOKEN,
		);

		expect(result.isError).toBeUndefined();
		expect(result.content[0]?.text).toContain("patched: f.txt (2 edits)");

		const blobInit = fetchMock.mock.calls[3][1] as RequestInit;
		const blobBody = JSON.parse(blobInit.body as string) as {
			content: string;
		};
		expect(Buffer.from(blobBody.content, "base64").toString("utf-8")).toBe(
			"ALPHA BETA gamma\n",
		);
	});

	it("rejects edits whose old_text appears multiple times", async () => {
		vi.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(jsonResponse({ object: { sha: "basecommit" } }))
			.mockResolvedValueOnce(jsonResponse({ tree: { sha: "basetree" } }))
			.mockResolvedValueOnce(contentsResponse("foo foo foo"));

		const result = await handlePatchFiles(
			{
				...validBase,
				edits: [{ path: "a.txt", old_text: "foo", new_text: "bar" }],
			},
			TOKEN,
		);

		expectErrorResult(result, /matched 3 locations/);
	});

	it("rejects edits whose old_text is not present", async () => {
		vi.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(jsonResponse({ object: { sha: "basecommit" } }))
			.mockResolvedValueOnce(jsonResponse({ tree: { sha: "basetree" } }))
			.mockResolvedValueOnce(contentsResponse("nothing matches"));

		const result = await handlePatchFiles(
			{
				...validBase,
				edits: [{ path: "a.txt", old_text: "missing", new_text: "x" }],
			},
			TOKEN,
		);

		expectErrorResult(result, /old_text not found/);
	});

	it("returns an error when the file does not exist on the branch", async () => {
		vi.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(jsonResponse({ object: { sha: "basecommit" } }))
			.mockResolvedValueOnce(jsonResponse({ tree: { sha: "basetree" } }))
			.mockResolvedValueOnce(new Response("not found", { status: 404 }));

		const result = await handlePatchFiles(
			{
				...validBase,
				edits: [{ path: "missing.txt", old_text: "x", new_text: "y" }],
			},
			TOKEN,
		);

		expectErrorResult(result, /not found on branch 'main'/);
	});

	it("returns an error when the branch ref cannot be fetched", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
			new Response("nope", { status: 422 }),
		);

		const result = await handlePatchFiles(
			{
				...validBase,
				edits: [{ path: "a.txt", old_text: "x", new_text: "y" }],
			},
			TOKEN,
		);

		expectErrorResult(result, /failed to fetch branch ref 'main'/);
	});

	it("URL-encodes branch names and file paths", async () => {
		const fetchMock = mockHappyPath({ fileContent: "x\n" });

		await handlePatchFiles(
			{
				owner: "o",
				repo: "r",
				branch: "feat/branch name",
				message: "msg",
				edits: [{ path: "dir name/file.txt", old_text: "x", new_text: "y" }],
			},
			TOKEN,
		);

		expect(fetchMock.mock.calls[0][0]).toBe(
			"https://api.github.com/repos/o/r/git/refs/heads/feat%2Fbranch%20name",
		);
		expect(fetchMock.mock.calls[2][0]).toBe(
			"https://api.github.com/repos/o/r/contents/dir%20name/file.txt?ref=feat%2Fbranch%20name",
		);
	});
});
