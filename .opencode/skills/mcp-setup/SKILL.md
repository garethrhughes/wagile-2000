---
name: mcp-setup
description: Interactive MCP server setup — presents a menu of available MCP servers (Context7, GitHub, Filesystem, Memory, Squirrel Notes, Semgrep) and writes the chosen config into opencode.json; invoked automatically by project-bootstrap and project-onboard.
compatibility: opencode
---

# MCP Setup Skill

You are the MCP Setup agent. Your job is to help the user choose and configure
MCP (Model Context Protocol) servers for their project by creating or updating
`opencode.json` in the project root.

---

## Operating Principles

1. **Always ask before writing.** Present the menu of available servers and let
   the user choose. Never add servers they did not select.
2. **Merge, never overwrite.** If `opencode.json` already exists, read it first
   and merge new MCP entries in — preserve any existing keys.
3. **Explain each option briefly.** The user may not know what each server does.
   One sentence per server is enough.
4. **Free tier first.** All recommended servers are free or have a meaningful
   free tier. Mention any costs or sign-up requirements upfront.

---

## Step 1 — Present the Menu

Ask the user which MCP servers they want to add. Present all six options and
allow multiple selections:

> "I can configure the following MCP servers for this project. All are free to
> run — I've noted where a service account or API key is needed.
>
> Which would you like to add? (Select any combination, or 'all', or 'none'.)"

### Available servers

| # | Name | What it does | Cost |
|---|------|--------------|------|
| 1 | **Context7** | Live library docs lookup — add `use context7` to any prompt | Free — higher rate limits with a free account |
| 2 | **GitHub** | Read/create PRs, issues, check CI status, search code | Free — needs a fine-grained Personal Access Token |
| 3 | **Filesystem** | Reliable local file operations (read, write, search) | Free — local only |
| 4 | **Memory** | Persistent knowledge graph across sessions | Free — local only |
| 5 | **Squirrel Notes** | Read/write your encrypted Squirrel Notes — create, search, append, tag notes from any prompt | Requires a Squirrel Notes account (free tier) and Pro for saved searches |
| 6 | **Semgrep** | Static analysis and security scanning inline | Free (OSS) — needs `semgrep` CLI installed |

Wait for the user's selection before proceeding.

---

## Step 2 — Collect required credentials

For each server that needs configuration beyond a URL:

**GitHub** — ask:
> "What GitHub Personal Access Token should be used? (You can use
> `{env:GITHUB_TOKEN}` to read it from an environment variable — recommended.)
>
> Use a **fine-grained PAT** scoped to only the repositories this project needs,
> with the minimum permissions required (e.g. `Contents: read`, `Pull requests: read/write`,
> `Issues: read/write`). Create one at github.com → Settings → Developer settings →
> Personal access tokens → Fine-grained tokens."

**Semgrep** — check silently whether `semgrep` is installed (`which semgrep`).
If not found, tell the user:
> "Semgrep CLI is not installed. Install it with `pip install semgrep` or
> `brew install semgrep`, then re-run this skill. I'll add the config now so
> it's ready when you install it."

**Context7** — optionally ask:
> "Do you have a Context7 API key for higher rate limits? If so, I'll add it as
> `{env:CONTEXT7_API_KEY}`. Leave blank to use the free unauthenticated tier."

**Squirrel Notes** — tell the user:
> "Squirrel Notes credentials must be set in your shell profile — add these to
> your `~/.zshrc` (or `~/.bashrc`) and restart your terminal:
>
> ```sh
> export SQUIRREL_API_KEY="sqn_your_api_key"
> export SQUIRREL_PASSPHRASE="your-passphrase"
> ```
>
> Find your API key at squirrelnotes.app → Settings → API."

For **Filesystem** and **Memory** — no credentials needed.

---

## Step 3 — Build the config

Construct the MCP block for `opencode.json` from the user's selections.

Use the following canonical config fragments for each server:

### Context7
```json
"context7": {
  "type": "remote",
  "url": "https://mcp.context7.com/mcp",
  "enabled": true
}
```
*(If the user provided an API key, add: `"headers": { "CONTEXT7_API_KEY": "{env:CONTEXT7_API_KEY}" }`)*

### GitHub
```json
"github": {
  "type": "local",
  "command": ["npx", "-y", "@modelcontextprotocol/server-github"],
  "environment": {
    "GITHUB_PERSONAL_ACCESS_TOKEN": "{env:GITHUB_TOKEN}"
  },
  "enabled": true
}
```
*(Replace `{env:GITHUB_TOKEN}` with the literal string the user provided if
they gave a different variable name or a direct value — never log or store raw
tokens.)*

### Filesystem
```json
"filesystem": {
  "type": "local",
  "command": ["npx", "-y", "@modelcontextprotocol/server-filesystem", "."],
  "enabled": true
}
```
*(`.` scopes the server to the project root. Adjust if the user requests a
different root.)*

### Memory
```json
"memory": {
  "type": "local",
  "command": ["npx", "-y", "@modelcontextprotocol/server-memory"],
  "enabled": true
}
```

### Squirrel Notes
```json
"squirrel-notes": {
  "type": "local",
  "command": ["npx", "-y", "@squirrelnotes.app/mcp"],
  "environment": {
    "SQUIRREL_API_BASE_URL": "https://api.squirrelnotes.app",
    "SQUIRREL_API_KEY": "{env:SQUIRREL_API_KEY}",
    "SQUIRREL_PASSPHRASE": "{env:SQUIRREL_PASSPHRASE}"
  },
  "enabled": true
}
```
*`SQUIRREL_API_KEY` and `SQUIRREL_PASSPHRASE` must be exported in your shell so
OpenCode can resolve the `{env:...}` substitutions. Add these to your `~/.zshrc`
(or `~/.bashrc`) and restart your terminal:*
```sh
export SQUIRREL_API_KEY="sqn_your_api_key"
export SQUIRREL_PASSPHRASE="your-passphrase"
```

### Semgrep
```json
"semgrep": {
  "type": "local",
  "command": ["semgrep", "mcp"],
  "enabled": true
}
```

---

## Step 4 — Write opencode.json

Check whether `opencode.json` exists in the project root:

- **If it exists:** read the file, merge the selected MCP entries into the
  existing `mcp` object, and write it back. Do not modify any other keys.
- **If it does not exist:** create it with the structure below.

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    ... selected servers ...
  }
}
```

---

## Step 5 — Confirm and explain

After writing the file, print a confirmation summary:

> "Updated `opencode.json` with the following MCP servers:
>
> {for each selected server, one bullet:}
> - **Context7** — live library docs. Add `use context7` to any prompt. Sign up at context7.com for higher rate limits.
> - **GitHub** — read/write PRs and issues; searches code. Requires a fine-grained PAT in `GITHUB_TOKEN` env var.
> - **Filesystem** — reliable file ops scoped to the project root.
> - **Memory** — persistent knowledge graph. Use `remember ...` and `recall ...` in prompts.
> - **Squirrel Notes** — read/write encrypted notes. Requires `SQUIRREL_API_KEY` and `SQUIRREL_PASSPHRASE` env vars.
> - **Semgrep** — static analysis. Use `run semgrep` in any prompt to scan for issues.
>
> Commit `opencode.json` to version control so the team shares the same MCP setup."

If the user selected **none**, say:

> "No MCP servers added. You can run this skill again at any time to add them."

---

## Notes for callers (project-bootstrap / project-onboard)

When this skill is invoked as **Step 3** of project-bootstrap or project-onboard,
it replaces the hardcoded context7-only MCP step in those skills.

After this skill completes, control returns to the calling skill to continue
with its Step 4 (Finish).
