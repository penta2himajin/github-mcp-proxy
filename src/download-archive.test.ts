import { afterEach, describe, expect, it, vi } from "vitest";
import { DOWNLOAD_ARCHIVE_TOOL, handleDownloadArchive } from "./download-archive";

const TOKEN = "ghs_test_token";

function redirectResponse(location: string, status = 302): Response {
	return new Response(null, {
		status,
		headers: location ? { Location: location } : {},
	});
}

function expectErrorResult(
	result: Awaited<ReturnType<typeof handleDownloadArchive>>,
	matcher: RegExp,
) {
	expect(result.isError).toBe(true);
	expect(result.content[0]?.text).toMatch(matcher);
}

describe("DOWNLOAD_ARCHIVE_TOOL schema", () => {
	it("declares the expected name and required fields", () => {
		expect(DOWNLOAD_ARCHIVE_TOOL.name).toBe("download_repository_archive");
		expect(DOWNLOAD_ARCHIVE_TOOL.inputSchema.required).toEqual(["owner", "repo"]);
		expect(DOWNLOAD_ARCHIVE_TOOL.inputSchema.properties.format.enum).toEqual([
			"zip",
			"tar.gz",
		]);
	});
});

describe("handleDownloadArchive - argument validation", () => {
	afterEach(() => vi.restoreAllMocks());

	it("rejects missing required arguments", async () => {
		const result = await handleDownloadArchive({ owner: "o" }, TOKEN);
		expectErrorResult(result, /missing required argument/i);
	});

	it("does not call the GitHub API for invalid input", async () => {
		const fetchMock = vi.spyOn(globalThis, "fetch");
		await handleDownloadArchive({}, TOKEN);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("rejects an unknown format", async () => {
		const fetchMock = vi.spyOn(globalThis, "fetch");
		const result = await handleDownloadArchive(
			{ owner: "o", repo: "r", format: "rar" },
			TOKEN,
		);
		expectErrorResult(result, /invalid format 'rar'/);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe("handleDownloadArchive - GitHub API flow", () => {
	afterEach(() => vi.restoreAllMocks());

	it("returns the signed redirect URL for a default-branch zip", async () => {
		const signed = "https://codeload.github.com/o/r/legacy.zip/refs/heads/main?token=abc";
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(redirectResponse(signed));

		const result = await handleDownloadArchive({ owner: "o", repo: "r" }, TOKEN);

		expect(result.isError).toBeUndefined();
		expect(result.content[0]?.text).toContain(signed);
		expect(result.content[0]?.text).toContain("(default branch)");
		expect(result.content[0]?.text).toContain("(zip)");

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [calledUrl, init] = fetchMock.mock.calls[0];
		expect(calledUrl).toBe("https://api.github.com/repos/o/r/zipball");
		expect((init as RequestInit).redirect).toBe("manual");
		const headers = (init as RequestInit).headers as Record<string, string>;
		expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
		expect(headers["User-Agent"]).toBe("github-mcp-proxy");
	});

	it("uses the tarball endpoint for tar.gz and includes the ref in the path", async () => {
		const signed = "https://codeload.github.com/o/r/tar.gz/v1.0?token=xyz";
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(redirectResponse(signed));

		const result = await handleDownloadArchive(
			{ owner: "o", repo: "r", ref: "v1.0", format: "tar.gz" },
			TOKEN,
		);

		expect(result.isError).toBeUndefined();
		expect(result.content[0]?.text).toContain(signed);
		expect(result.content[0]?.text).toContain("v1.0");
		expect(fetchMock.mock.calls[0][0]).toBe(
			"https://api.github.com/repos/o/r/tarball/v1.0",
		);
	});

	it("URL-encodes ref segments while preserving slashes", async () => {
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(redirectResponse("https://codeload.github.com/x"));

		await handleDownloadArchive(
			{ owner: "o", repo: "r", ref: "feature/new thing" },
			TOKEN,
		);

		expect(fetchMock.mock.calls[0][0]).toBe(
			"https://api.github.com/repos/o/r/zipball/feature/new%20thing",
		);
	});

	it("errors when the redirect has no Location header", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(redirectResponse(""));

		const result = await handleDownloadArchive({ owner: "o", repo: "r" }, TOKEN);
		expectErrorResult(result, /without a Location header/);
	});

	it("maps a 404 to a not-found error", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
			new Response("nope", { status: 404 }),
		);

		const result = await handleDownloadArchive(
			{ owner: "o", repo: "missing", ref: "main" },
			TOKEN,
		);
		expectErrorResult(result, /not found, or the token lacks access/);
	});

	it("surfaces unexpected status codes", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
			new Response("boom", { status: 500 }),
		);

		const result = await handleDownloadArchive({ owner: "o", repo: "r" }, TOKEN);
		expectErrorResult(result, /unexpected response from GitHub: 500/);
	});

	it("handles fetch rejections gracefully", async () => {
		vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("network down"));

		const result = await handleDownloadArchive({ owner: "o", repo: "r" }, TOKEN);
		expectErrorResult(result, /request to GitHub failed.*network down/);
	});
});
