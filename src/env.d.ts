// Augments the auto-generated `worker-configuration.d.ts` with bindings that
// `wrangler types` does not infer (currently: secrets, which are configured at
// deploy time via `wrangler secret put` rather than declared in wrangler.jsonc).
declare namespace Cloudflare {
	interface Env {
		GITHUB_CLIENT_ID: string;
		GITHUB_CLIENT_SECRET: string;
		COOKIE_ENCRYPTION_KEY: string;
	}
}
