# OpenCode Skills

Reusable OpenCode skills for structured software development with AI agents.

## Skills

| Name | Description |
|---|---|
| [architect](architect/SKILL.md) | Drives technical design decisions, writes proposals before significant changes, and maintains the proposal index |
| [developer](developer/SKILL.md) | Writes production-quality TypeScript following TDD (red-green-refactor) and project conventions |
| [reviewer](reviewer/SKILL.md) | Reviews staged changes for security, correctness, performance, IaC safety, observability, and convention adherence; returns a PASS / PASS WITH COMMENTS / BLOCK verdict with Acceptance Criteria traceability |
| [infosec](infosec/SKILL.md) | Read-only security and compliance audit (ISO27001-aligned by default). Audits encryption, access control, audit logging, secrets, IAM, network exposure, and supply chain. Returns APPROVED / REQUIRES CHANGES / APPROVED WITH EXCEPTION |
| [decision-log](decision-log/SKILL.md) | Captures and maintains architectural decisions (ADRs) in `docs/decisions/` with a running index |
| [create-feature](create-feature/SKILL.md) | Full feature development cycle: proposal → implementation → review → infosec sign-off → decision logging → PR |
| [project-bootstrap](project-bootstrap/SKILL.md) | Interactive bootstrap that asks a structured set of questions (app stack, IaC, observability, security/compliance, domain) and produces a complete CLAUDE.md and Project Context block |
| [project-onboard](project-onboard/SKILL.md) | Interactive onboarding for an existing codebase — investigates the repo to fill in CLAUDE.md and the Project Context block, asking the user only what the code can't answer |
| [mcp-setup](mcp-setup/SKILL.md) | Interactive MCP server setup — presents a menu of free MCP servers (Context7, GitHub, Filesystem, Fetch, Memory, Semgrep) and writes the chosen config into `opencode.json`; invoked automatically by `project-bootstrap` and `project-onboard` |
| [create-skill](create-skill/SKILL.md) | Interactively creates or updates OpenCode skills — asks structured questions about purpose, workflow, MCP tools, and output format, then produces a complete SKILL.md and updates the README |
| [update-skills](update-skills/SKILL.md) | Pulls the latest skills from the upstream repository and reports what changed (added, removed, modified) with a unified diff per skill |

## Setup

Choose the approach that fits your workflow.

---

### Option A — Global symlink (use skills across all projects)

Skills live in one place and are available in every OpenCode session.

**1. Clone the repository**

```bash
git clone https://github.com/garethrhughes/skills ~/Documents/skills
```

**2. Symlink into OpenCode's global skills directory**

```bash
ln -s ~/Documents/skills ~/.config/opencode/skills
```

**3. Verify**

Open OpenCode and check that the skills appear in the skill tool. You should see `architect`,
`developer`, `reviewer`, `infosec`, `decision-log`, `create-feature`, `project-bootstrap`,
`project-onboard`, `mcp-setup`, and `update-skills` listed.

---

### Option B — Copy into a project (version skills alongside your code)

Skills live inside the project repository. Useful when you want to customise skills
per-project, pin them at a specific version, or commit them to the repo so the whole team
shares the same definitions.

**1. Copy the skills directory into your project**

```bash
# From your project root
cp -r ~/Documents/skills .opencode/skills

# Or, if you haven't cloned the repo yet:
git clone --depth 1 https://github.com/garethrhughes/skills .opencode/skills && rm -rf .opencode/skills/.git
```

**2. Verify**

Open OpenCode from your project root and check that the skills appear in the skill tool.

**3. Configure the project context**

Run the `project-bootstrap` skill to interactively configure your project. It will ask
structured questions about your stack, infrastructure, observability, and security posture,
then produce a complete `CLAUDE.md` and populate the `## Project Context` block in each
skill automatically.

```
Use the project-bootstrap skill to set up this project.
```

Alternatively, edit the `## Project Context` section of each SKILL.md directly — changes
are tracked in version control alongside your code.

---

### Option C — Both (global base, project-level overrides)

Keep the global symlink for the base skills and copy only the skills you want to override
into `.opencode/skills/` in a specific project. OpenCode will prefer the project-local
version when both exist.

## Use with other AI tools

The skill content is plain Markdown and works anywhere you can provide a system prompt.
Two helper scripts handle the mechanical parts of installing skills as agents for other tools.

---

### GitHub Copilot agents

Symlinks each skill into `.github/agents/` in your project root. Copilot picks up `.md`
files in that directory as custom agents automatically.

```bash
# From your project root
bash path/to/skills/scripts/install-copilot-agents.sh

# Or if skills are global:
bash ~/.config/opencode/skills/scripts/install-copilot-agents.sh
```

Re-run whenever skills change — symlinks always point at the latest content.

> **Note:** The `compatibility: opencode` and `permission:` frontmatter blocks are
> ignored by Copilot. The `infosec` skill's read-only intent is advisory; Copilot has
> no runtime enforcement equivalent.

---

### Claude Code subagents

Generates a `.claude/agents/<skill-name>.md` file for each skill. Unlike the Copilot
script, this one transforms the content rather than symlinking, because Claude Code uses
different frontmatter fields (`tools`, `description`) and some skills need tool
restrictions baked in (e.g. `infosec` is restricted to read-only tools).

```bash
# From your project root
bash path/to/skills/scripts/install-claude-agents.sh

# Or if skills are global:
bash ~/.config/opencode/skills/scripts/install-claude-agents.sh
```

Re-run whenever skills change to regenerate the agent files from the latest skill content.

The script applies these tool restrictions automatically:

| Agent | Tools |
|---|---|
| `infosec` | `Read, Grep, Glob, WebFetch` — read-only, never edits |
| `reviewer` | `Read, Grep, Glob, Bash` |
| `architect` | `Read, Grep, Glob, Write, Edit, WebFetch` |
| `decision-log` | `Read, Grep, Glob, Write, Edit` |
| `developer`, `create-feature`, `project-bootstrap` | All tools |

Commit `.claude/agents/` to version control so your whole team shares the same agents.
Claude Code loads them automatically at session start.

---

## Usage

Reference a skill in any OpenCode prompt by name:

```
Use the architect skill to design a caching strategy for the sync module.
```

```
Use the developer skill to implement the feature described in proposal 0042.
```

```
Use the reviewer skill to review the staged changes in this branch.
```

```
Use the infosec skill to audit this PR for ISO27001 compliance and security issues.
```

```
Use the decision-log skill to log the decision made in the last conversation.
```

```
Use the create-feature skill to walk through the full feature cycle for this task.
```

```
Use the project-bootstrap skill to set up this project.
```

```
Use the project-onboard skill to onboard this existing codebase.
```

```
Use the update-skills skill to update all skills to the latest version.
```

### mcp-setup

Run this skill to configure MCP servers for a project. It presents a menu of six free options
and writes the selected config into `opencode.json` in the project root, merging with any
existing config. It is invoked automatically as part of `project-bootstrap` and `project-onboard`,
but can also be run standalone at any time to add or reconfigure servers.

```
Use the mcp-setup skill to configure MCP servers for this project.
```

### project-bootstrap

Run this skill once when starting a **new project**. It walks through a structured interview
covering app stack, infrastructure, observability, security/compliance, and domain decisions.
Accept the opinionated defaults by saying "yes" or "default" at any phase, or provide your own
values. At the end it produces:

- A fully populated `CLAUDE.md` in the project root
- A `## Project Context` block automatically inserted into each skill in `.opencode/skills/`

```
Use the project-bootstrap skill to set up this project.
```

### project-onboard

Run this skill once when **adopting an existing codebase**. Instead of interviewing you from
scratch, it reads the repo first — package files, config, IaC, CI/CD — and only asks you for
what the code cannot answer. At the end it produces the same outputs as `project-bootstrap`:

- A fully populated `CLAUDE.md` in the project root
- A `## Project Context` block automatically inserted into each skill in `.opencode/skills/`

```
Use the project-onboard skill to onboard this existing codebase.
```

## Customisation

Each skill contains a `## Project Context` section near the top. This section is intentionally
left as a placeholder — fill it in before use.

**Recommended approach:** copy the content of your project's `CLAUDE.md` into the `## Project Context`
section of each skill, or paste it at the start of a conversation with instructions like:

> "Here is my project context — treat this as the project context for the skill you are using."

A `CLAUDE.md.template` file is provided in this repository as a starting point for new projects.

> **Note:** in OpenCode, your project's `CLAUDE.md` is already loaded into every conversation automatically — you may not need to repeat the full context in each skill's `## Project Context` section. Instead, focus on any skill-specific overrides or additions.

## CLAUDE.md Template

See [`CLAUDE.md.template`](CLAUDE.md.template) for a generic `CLAUDE.md` structure you can
copy into any new project and fill in.
