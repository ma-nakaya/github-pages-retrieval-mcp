# GitHub Pages Retrieval MCP

Local stdio MCP server that retrieves private GitHub Pages through an authenticated, persistent browser profile. It treats the rendered Pages site as the only source and never uses the source repository or GitHub API.

## What it provides

- A separate persistent browser profile for each configured Pages source.
- Explicit, visible reauthentication for GitHub, SAML, and MFA.
- Allowlisted Pages-only retrieval through Playwright.
- Local authentication-state tracking without exposing cookies or credentials through MCP.

## Setup

1. Install Node.js 22 or newer, then run `npm install`.
2. Copy `config.example.json` to `config.local.json` and replace the example URL and origin.
3. Run `npm start` from the repository root.
4. Connect the command as a local stdio MCP server.

Example Codex configuration:

```toml
[mcp_servers.github_pages_retrieval]
command = "npm"
args = ["start"]
cwd = "C:/path/to/github-pages-retrieval-mcp"
```

## Authentication flow

1. Call `begin_source_reauth` for a source. A visible local browser opens at the configured Pages URL.
2. Complete GitHub, SAML, and MFA in that browser. The server does not automate or receive those credentials.
3. Call `validate_source_auth`. The server validates the protected Pages URL and stores only `ready` or `auth_required` plus its timestamp.
4. Use `fetch_pages_content` for an allowlisted Pages URL.

If authentication expires, `fetch_pages_content` records `auth_required`. Start the same explicit flow again.

## Safety boundaries

- Do not use a daily-use browser profile. The configured profile directory is a credential-bearing asset.
- Keep `config.local.json` and `.data/` private; both are ignored by Git.
- Do not point `allowedOrigins` at GitHub repository URLs. The MCP accepts only configured Pages origins.
- This first version retrieves and returns one page. Crawling, chunking, and local full-text/vector indexing should be added after a real Pages source is validated.
