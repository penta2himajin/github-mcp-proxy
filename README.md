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

## Local development

```bash
# Create .dev.vars from the example
cp .dev.vars.example .dev.vars
# Fill in GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, COOKIE_ENCRYPTION_KEY

npm run dev
```


## License

MIT
