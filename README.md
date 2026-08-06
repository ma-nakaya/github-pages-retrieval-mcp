# GitHub Pages Retrieval MCP

Local stdio MCP server that retrieves private GitHub Pages through an authenticated, persistent browser profile. It treats the rendered Pages site as the only source and never uses the source repository or GitHub API.

The repository is an Agent Plugin for Claude Code and GitHub Copilot CLI. It bundles the MCP configuration and the `github-pages-retrieval` skill. Both clients start the same local stdio process.

## What it provides

- A separate persistent browser profile for each configured Pages source.
- Explicit, visible reauthentication for GitHub, SAML, and MFA.
- Allowlisted Pages-only retrieval through Playwright.
- Local authentication-state tracking without exposing cookies or credentials through MCP.

## Setup

1. Install Node.js 22 or newer, then run `npm install`.
2. For standalone use, copy `config.example.json` to `config.local.json` and replace the example URL and origin.
3. Run `npm start` from the repository root.
4. Connect the command as a local stdio MCP server.

## Plugin installation

Install dependencies once in the plugin directory before enabling it. The package intentionally does not run installation scripts automatically.

### Claude Code

```sh
/plugin marketplace add ma-nakaya/github-pages-retrieval-mcp
/plugin install github-pages-retrieval@github-pages-retrieval-marketplace
```

Claude Code supplies a private persistent data directory through `CLAUDE_PLUGIN_DATA`. Create `config.local.json` there using `config.example.json`, then use the bundled skill to start authentication.

### GitHub Copilot CLI

```sh
copilot plugin marketplace add ma-nakaya/github-pages-retrieval-mcp
copilot plugin install github-pages-retrieval@github-pages-retrieval-marketplace
```

For durable browser state across plugin updates, set `GPR_PLUGIN_DATA` to a private local directory in Copilot's MCP server environment, then create `config.local.json` there from `config.example.json`. If it is unset, the server uses `.data/` inside the installed plugin directory.

The plugin targets local Copilot CLI. Copilot cloud agent and code review run in GitHub-hosted environments and cannot reuse a user's local interactive browser profile for GitHub/SAML/MFA.

For GitHub Copilot in an IDE, register the same local command from the installed plugin directory in the IDE's MCP configuration. The bundled plugin itself is currently validated for Copilot CLI.

Example standalone configuration:

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
