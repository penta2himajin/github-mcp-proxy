# github-mcp-proxy

Cloudflare Worker that acts as an MCP proxy for GitHub. It handles GitHub OAuth authentication and forwards all MCP requests to GitHub's official MCP server (`api.githubcopilot.com/mcp/`).

Use this as a custom MCP connector on claude.ai to get full access to GitHub's MCP tools (including write operations like creating issues, PRs, and pushing code).

## How it works

1. Client connects to your Worker's `/mcp` endpoint
2. Worker triggers GitHub OAuth flow (with `read:user,repo` scopes)
3. After authentication, the Worker transparently proxies all MCP requests to `api.githubcopilot.com/mcp/x/all/` (all toolsets enabled, including `actions`), injecting the user's GitHub token as `Authorization: Bearer`

## Setup

### 1. Create a GitHub OAuth App

1. Go to **GitHub Settings > Developer settings > OAuth Apps > New OAuth App**
2. Set **Authorization callback URL** to `https://<your-worker>.workers.dev/callback`
3. Note the **Client ID** and generate a **Client Secret**

### 2. Deploy to Cloudflare

```bash
# Install dependencies
npm install

# Create the KV namespace
npx wrangler kv namespace create OAUTH_KV
# Copy the returned ID into wrangler.jsonc

# Set secrets
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
npx wrangler secret put COOKIE_ENCRYPTION_KEY   # any random string

# Deploy
npm run deploy
```

### 3. Connect from claude.ai

1. Go to **claude.ai > Settings > Integrations > Add custom MCP connector**
2. Enter your Worker URL: `https://<your-worker>.workers.dev/mcp`
3. Claude will redirect you to GitHub for authentication
4. Once authorized, all GitHub MCP tools become available in your conversations

## Custom tools

On top of the upstream GitHub MCP toolset, the proxy advertises and services a
few tools of its own:

- **`patch_files`** — apply targeted text edits to existing files on a branch in
  a single atomic commit.
- **`download_repository_archive`** — get a temporary, signed download URL for a
  repository archive. The request is authenticated with the user's token, so it
  works for **private** repositories. The proxy follows the GitHub archive
  endpoint's redirect and returns the resulting `codeload.github.com` URL, which
  is short-lived and downloadable without further authentication (the GitHub
  token is never embedded in the URL). Arguments: `owner`, `repo`, optional
  `ref` (branch/tag/SHA, defaults to the repository's default branch), and
  optional `format` (`zip` or `tar.gz`, defaults to `zip`).

## Local development

```bash
# Create .dev.vars from the example
cp .dev.vars.example .dev.vars
# Fill in GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, COOKIE_ENCRYPTION_KEY

npm run dev
```


## License

MIT
