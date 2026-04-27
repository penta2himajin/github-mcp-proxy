import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { GitHubHandler } from "./github-handler";
import { handlePatchFile, PATCH_FILE_TOOL } from "./patch-file";

const UPSTREAM_MCP_URL = "https://api.githubcopilot.com/mcp/";

interface JsonRpcRequest {
	jsonrpc?: string;
	id?: string | number | null;
	method?: string;
	params?: any;
}

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

		// Intercept JSON-RPC on POSTs to the MCP root so we can advertise and
		// service our own `patch_file` tool. Everything else streams through.
		if (
			request.method === "POST" &&
			subPath === "" &&
			(request.headers.get("content-type") ?? "").includes("application/json")
		) {
			const bodyText = await request.text();
			const parsed = tryParseJson(bodyText);
			const single = !Array.isArray(parsed) && isJsonRpcRequest(parsed) ? parsed : null;

			if (single?.method === "tools/call" && single.params?.name === "patch_file") {
				const result = await handlePatchFile(
					single.params?.arguments ?? {},
					props.accessToken,
				);
				return jsonRpcResponse(single.id ?? null, result);
			}

			const upstreamResponse = await forwardRequest(
				request,
				upstreamUrl,
				bodyText,
				props.accessToken,
			);

			if (single?.method === "tools/list") {
				return injectPatchFileTool(upstreamResponse);
			}
			return upstreamResponse;
		}

		// Pure passthrough for everything else (GETs, DELETEs, sub-paths, etc.)
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

		return new Response(upstreamResponse.body, {
			status: upstreamResponse.status,
			statusText: upstreamResponse.statusText,
			headers: upstreamResponse.headers,
		});
	},
};

function tryParseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as any).method === "string"
	);
}

async function forwardRequest(
	request: Request,
	upstreamUrl: URL,
	body: string,
	accessToken: string,
): Promise<Response> {
	const headers = new Headers(request.headers);
	headers.set("Authorization", `Bearer ${accessToken}`);
	headers.delete("Host");
	headers.delete("Content-Length");
	return fetch(upstreamUrl.toString(), {
		method: request.method,
		headers,
		body,
	});
}

function jsonRpcResponse(id: string | number | null, result: unknown): Response {
	return new Response(
		JSON.stringify({ jsonrpc: "2.0", id, result }),
		{ status: 200, headers: { "Content-Type": "application/json" } },
	);
}

async function injectPatchFileTool(upstreamResponse: Response): Promise<Response> {
	const ct = upstreamResponse.headers.get("content-type") ?? "";

	if (ct.includes("application/json")) {
		const text = await upstreamResponse.text();
		const obj = tryParseJson(text) as any;
		if (obj?.result?.tools && Array.isArray(obj.result.tools)) {
			obj.result.tools.push(PATCH_FILE_TOOL);
			return rewriteBody(upstreamResponse, JSON.stringify(obj));
		}
		return rewriteBody(upstreamResponse, text);
	}

	if (ct.includes("text/event-stream")) {
		const text = await upstreamResponse.text();
		const rewritten = text.replace(/^data:[ \t]?(.+)$/gm, (line, payload) => {
			const obj = tryParseJson(payload) as any;
			if (obj?.result?.tools && Array.isArray(obj.result.tools)) {
				obj.result.tools.push(PATCH_FILE_TOOL);
				return `data: ${JSON.stringify(obj)}`;
			}
			return line;
		});
		return rewriteBody(upstreamResponse, rewritten);
	}

	return upstreamResponse;
}

function rewriteBody(original: Response, body: string): Response {
	const headers = new Headers(original.headers);
	headers.delete("content-length");
	headers.delete("content-encoding");
	return new Response(body, {
		status: original.status,
		statusText: original.statusText,
		headers,
	});
}

export default new OAuthProvider({
	apiHandler: proxyHandler,
	apiRoute: "/mcp",
	authorizeEndpoint: "/authorize",
	clientRegistrationEndpoint: "/register",
	defaultHandler: GitHubHandler as any,
	tokenEndpoint: "/token",
});
