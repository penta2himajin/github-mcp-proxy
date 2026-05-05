import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchUpstreamAuthToken, getUpstreamAuthorizeUrl } from "./utils";

describe("getUpstreamAuthorizeUrl", () => {
	it("encodes all required parameters", () => {
		const url = getUpstreamAuthorizeUrl({
			upstream_url: "https://github.com/login/oauth/authorize",
			client_id: "abc123",
			scope: "repo user:email",
			redirect_uri: "https://example.com/callback",
		});

		const parsed = new URL(url);
		expect(parsed.origin + parsed.pathname).toBe(
			"https://github.com/login/oauth/authorize",
		);
		expect(parsed.searchParams.get("client_id")).toBe("abc123");
		expect(parsed.searchParams.get("scope")).toBe("repo user:email");
		expect(parsed.searchParams.get("redirect_uri")).toBe(
			"https://example.com/callback",
		);
		expect(parsed.searchParams.get("response_type")).toBe("code");
		expect(parsed.searchParams.has("state")).toBe(false);
	});

	it("includes state when provided", () => {
		const url = getUpstreamAuthorizeUrl({
			upstream_url: "https://github.com/login/oauth/authorize",
			client_id: "abc",
			scope: "repo",
			redirect_uri: "https://example.com/cb",
			state: "xyz=",
		});
		const parsed = new URL(url);
		expect(parsed.searchParams.get("state")).toBe("xyz=");
	});

	it("preserves existing query parameters on the upstream URL", () => {
		const url = getUpstreamAuthorizeUrl({
			upstream_url: "https://example.com/auth?prompt=consent",
			client_id: "abc",
			scope: "repo",
			redirect_uri: "https://example.com/cb",
		});
		const parsed = new URL(url);
		expect(parsed.searchParams.get("prompt")).toBe("consent");
		expect(parsed.searchParams.get("client_id")).toBe("abc");
	});
});

describe("fetchUpstreamAuthToken", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	const baseOpts = {
		client_id: "id",
		client_secret: "secret",
		redirect_uri: "https://example.com/cb",
		upstream_url: "https://github.com/login/oauth/access_token",
	};

	it("returns a 400 response when code is missing", async () => {
		const [token, err] = await fetchUpstreamAuthToken({
			...baseOpts,
			code: undefined,
		});
		expect(token).toBeNull();
		expect(err).toBeInstanceOf(Response);
		expect(err?.status).toBe(400);
	});

	it("posts form-encoded credentials and returns the access token", async () => {
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(
				new Response("access_token=tok&token_type=bearer", {
					status: 200,
					headers: { "Content-Type": "application/x-www-form-urlencoded" },
				}),
			);

		const [token, err] = await fetchUpstreamAuthToken({
			...baseOpts,
			code: "abc",
		});

		expect(err).toBeNull();
		expect(token).toBe("tok");

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [calledUrl, calledInit] = fetchMock.mock.calls[0];
		expect(calledUrl).toBe(baseOpts.upstream_url);
		expect(calledInit?.method).toBe("POST");
		expect(
			(calledInit?.headers as Record<string, string>)["Content-Type"],
		).toBe("application/x-www-form-urlencoded");
		const body = new URLSearchParams(calledInit?.body as string);
		expect(body.get("client_id")).toBe("id");
		expect(body.get("client_secret")).toBe("secret");
		expect(body.get("code")).toBe("abc");
		expect(body.get("redirect_uri")).toBe(baseOpts.redirect_uri);
	});

	it("returns a 500 response when upstream errors", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
			new Response("nope", { status: 401 }),
		);

		const [token, err] = await fetchUpstreamAuthToken({
			...baseOpts,
			code: "abc",
		});
		expect(token).toBeNull();
		expect(err?.status).toBe(500);
	});

	it("returns a 400 response when access_token is missing from upstream response", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
			new Response("error=invalid_grant", {
				status: 200,
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
			}),
		);

		const [token, err] = await fetchUpstreamAuthToken({
			...baseOpts,
			code: "abc",
		});
		expect(token).toBeNull();
		expect(err?.status).toBe(400);
	});
});
