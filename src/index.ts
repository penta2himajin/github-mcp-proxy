import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { GitHubHandler } from "./github-handler";

const UPSTREAM_MCP_URL = "https://api.githubcopilot.com/mcp/";

// The apiHandler receives (request, env, ctx) where ctx.props
// is set by OAuthProvider after token validation.
const proxyHandler: ExportedHandler<Env> = {
	async fetch(request, _env, ctx) {
		const props = (ctx as any).props as {
			login: string;
			name: string;
			email: string;
			accessToken: string;
		};

		if (!props?.accessToken) {
			return new Response("Unauthorized", { status: 401 });
		}

		// Build upstream URL preserving any sub-path after /mcp
		const url = new URL(request.url);
		const subPath = url.pathname.replace(/^\/mcp\/?/, "");
		const upstreamUrl = new URL(subPath, UPSTREAM_MCP_URL);

		// Forward the request to GitHub's MCP server
		const headers = new Headers(request.headers);
		headers.set("Authorization", `Bearer ${props.accessToken}`);
		headers.delete("Host");

		const upstreamResponse = await fetch(upstreamUrl.toString(), {
			method: request.method,
			headers,
			body: request.body,
			// @ts-expect-error — Cloudflare Workers supports duplex
			duplex: "half",
		});

		// Return the upstream response as-is (streaming)
		return new Response(upstreamResponse.body, {
			status: upstreamResponse.status,
			statusText: upstreamResponse.statusText,
			headers: upstreamResponse.headers,
		});
	},
};

export default new OAuthProvider({
	apiHandler: proxyHandler,
	apiRoute: "/mcp",
	authorizeEndpoint: "/authorize",
	clientRegistrationEndpoint: "/register",
	defaultHandler: GitHubHandler as any,
	tokenEndpoint: "/token",
});
