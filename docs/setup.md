# Fragile — Practical Setup Guide

This guide walks through everything you need to get Fragile running against a real Jira Cloud
instance, including how to find and configure the tenant-specific custom field IDs that differ
between Jira organisations.

---

## Prerequisites

- Node.js 20+
- PostgreSQL 16 (Docker is the easiest path — see below)
- A Jira Cloud account with at least one Jira Software project
- A Jira API token (see [Creating a Jira API token](#1-create-a-jira-api-token))

---

## Step 1 — Create a Jira API token

1. Log in to [https://id.atlassian.com](https://id.atlassian.com).
2. Go to **Security** → **API tokens** → **Create API token**.
3. Give it a name (e.g. `fragile`) and copy the token — you will not see it again.
4. Note the email address of the account that owns the token.

The account needs these permissions on every project you want to track:

| Permission | Why |
|---|---|
| **Browse projects** | Read issues, sprints, versions |
| **View development tools** | Read changelogs |
| **View ideas** (JPD only) | Read JPD ideas for roadmap accuracy |

A dedicated read-only service account is recommended for production use.

---

## Step 2 — Start PostgreSQL

```bash
docker compose up -d
```

This starts PostgreSQL 16 on port 5432 with database `fragile`, user `postgres`,
password `postgres`. Edit `docker-compose.yml` if you need different values.

---

## Step 3 — Configure the backend

```bash
cp backend/.env.example backend/.env
```

Edit `backend/.env`:

```dotenv
JIRA_BASE_URL=https://yourorg.atlassian.net
JIRA_USER_EMAIL=you@yourorg.com
JIRA_API_TOKEN=your_token_here

DB_HOST=localhost
DB_PORT=5432
DB_USERNAME=postgres
DB_PASSWORD=postgres
DB_DATABASE=fragile

PORT=3001
FRONTEND_URL=http://localhost:3000
TIMEZONE=Australia/Sydney   # IANA timezone for quarter/week boundary calculations
```

---

## Step 4 — Run database migrations

```bash
make migrate
```

This compiles the backend and runs all pending TypeORM migrations, including the initial schema
and the `AddJiraFieldConfig` migration that seeds the `jira_field_config` singleton row with
sensible defaults.

---

## Step 5 — Configure boards

```bash
cp backend/config/boards.example.yaml backend/config/boards.yaml
```

Edit `backend/config/boards.yaml` and add one entry per Jira project:

```yaml
boards:
  - boardId: ACC          # Your Jira project key
    boardType: scrum      # "scrum" or "kanban"
    doneStatusNames:
      - Done
      - Released
```

The file is read on every backend startup and upserts the database. Partial entries are safe —
omitted fields are never overwritten.

---

## Step 6 — Find your Jira custom field IDs

Jira custom field IDs are tenant-specific. You need to identify them before Fragile can read
story points and JPD date fields correctly.

### Story point field IDs

Story points are stored in a custom field. Common field IDs:

| Jira project type | Typical field ID |
|---|---|
| Next-gen / team-managed | `customfield_10016` |
| Classic board story points | `customfield_10028` |
| Some older configurations | `story_points` |

**To confirm your IDs:**

```bash
curl -u you@yourorg.com:YOUR_TOKEN \
  "https://yourorg.atlassian.net/rest/api/3/issue/ACC-1?fields=*all" \
  | jq '.fields | to_entries[] | select(.value | type == "number") | .key'
```

Look for entries like `customfield_10016: 3` — those are your story point fields.

Add them to `backend/config/boards.yaml` under the `jira:` stanza:

```yaml
jira:
  storyPointsFieldIds:
    - story_points
    - customfield_10016
    - customfield_10026
    - customfield_10028
    - customfield_11031
```

If you omit this stanza, Fragile uses all five IDs above by default.

### Epic Link field ID

Older Jira projects use a custom "Epic Link" field (not the native parent field) to associate
issues with their parent Epic. The default field ID is `customfield_10014`.

**To confirm:**

```bash
curl -u you@yourorg.com:YOUR_TOKEN \
  "https://yourorg.atlassian.net/rest/api/3/issue/ACC-1?fields=*all" \
  | jq '.fields | to_entries[] | select(.value | type == "string" and test("^[A-Z]+-[0-9]+$")) | .key'
```

Look for a field whose value is an issue key (e.g. `"ACC-42"`) — that is your Epic Link field.

To configure:

```yaml
jira:
  epicLinkFieldId: customfield_10014   # replace with your actual ID, or null to disable
```

### JPD delivery link type names

When you use Jira's native **Delivery** panel to link a Jira Software issue to a JPD idea, Jira
creates an issue link with a specific type name. The default names Fragile recognises are
`"is implemented by"` and `"is delivered by"` (inward), and `"implements"` and `"delivers"`
(outward).

**To confirm your link type names:**

```bash
curl -u you@yourorg.com:YOUR_TOKEN \
  "https://yourorg.atlassian.net/rest/api/3/issueLinkType" \
  | jq '.issueLinkTypes[] | {name, inward, outward}'
```

Find the entry that corresponds to delivery/implementation links. It might be called
`"Delivery"`, `"Implements"`, or something tenant-specific.

To configure:

```yaml
jira:
  jpdDeliveryLinkInward: "is delivered by"
  jpdDeliveryLinkOutward: "delivers"
```

### JPD date field IDs

Roadmap accuracy requires start and target date fields on JPD ideas. These are Polaris interval
fields (`jira.polaris:interval`) and differ between tenants.

**To find them:**

```bash
curl -u you@yourorg.com:YOUR_TOKEN \
  "https://yourorg.atlassian.net/rest/api/3/issue/DISC-1?fields=*all" \
  | jq '.fields | to_entries[] | select(.value | type == "object" and has("start")) | .key'
```

Look for fields whose value has `{"start": "YYYY-MM-DD", "end": "YYYY-MM-DD"}`.

Add them to `backend/config/roadmap.yaml`:

```yaml
roadmaps:
  - jpdKey: DISC
    startDateFieldId: "customfield_10056"
    targetDateFieldId: "customfield_10057"
```

---

## Step 7 — Configure roadmaps (optional)

```bash
cp backend/config/roadmap.example.yaml backend/config/roadmap.yaml
```

Edit `backend/config/roadmap.yaml` with the field IDs found in the previous step:

```yaml
roadmaps:
  - jpdKey: DISC
    description: "Discovery roadmap"
    startDateFieldId: "customfield_10056"
    targetDateFieldId: "customfield_10057"
```

---

## Step 8 — Start the servers

```bash
# Terminal 1
make dev-api     # NestJS on port 3001

# Terminal 2
make dev-web     # Next.js on port 3000
```

Watch the backend startup logs. You should see lines like:

```
[YamlConfigService] YAML config: 2 board config(s) applied from boards.yaml
[YamlConfigService] YAML config: jira field config applied from boards.yaml jira: stanza
[YamlConfigService] YAML config: 1 roadmap config(s) applied from roadmap.yaml
```

---

## Step 9 — Trigger the first sync

Open [http://localhost:3000](http://localhost:3000), navigate to **Settings**, and click
**Sync now**. The first sync fetches all sprints, issues, changelogs, versions, and JPD ideas.
It may take a few minutes for large projects.

---

## Troubleshooting

### Story points are always null

The story point field IDs in `jira_field_config` do not match your Jira instance. Follow
[Step 6](#story-point-field-ids) to find the correct IDs and update `boards.yaml`.

### Roadmap coverage is 0%

- Confirm `jpdDeliveryLinkInward` matches the actual link type name in your Jira instance.
- Confirm `startDateFieldId` and `targetDateFieldId` are set in `roadmap.yaml`.
- Ensure the JPD ideas have start and target dates set — ideas without dates are excluded.

### "Planning accuracy is not available for Kanban boards"

This is expected behaviour. Set `boardType: scrum` for sprint-based boards.

### Backend fails to start with "boards.yaml validation failed"

The YAML file has a validation error. The startup message lists every failing field and path.
Common causes:
- `boardType` set to something other than `"scrum"` or `"kanban"`
- `dataStartDate` not in `YYYY-MM-DD` format
- Duplicate `boardId` entries

### TypeORM migration fails

Run `make migrate` after `make install`. If the database schema is out of date, run:

```bash
cd backend && npm run build && npm run migration:run
```

---

## Full `jira:` stanza reference

```yaml
jira:
  # List of custom field IDs to try for story points. First non-null value wins.
  # Default: all five IDs below.
  storyPointsFieldIds:
    - story_points          # legacy Jira Server / some older cloud projects
    - customfield_10016     # "Story point estimate" (classic projects)
    - customfield_10026     # "Story Points" (classic projects, older)
    - customfield_10028     # "Story Points" (some cloud instances)
    - customfield_11031     # "Story point estimate" (team-managed / next-gen)

  # Legacy Epic Link field ID. Set to null to use only the native parent field.
  epicLinkFieldId: customfield_10014

  # JPD delivery link type names. Must match Jira's link type panel exactly.
  # Accepts a bare string or a list. Default: both values shown below.
  jpdDeliveryLinkInward:
    - "is implemented by"
    - "is delivered by"
  jpdDeliveryLinkOutward:
    - "implements"
    - "delivers"
```

All fields in the `jira:` stanza are optional. Omitting a field preserves the current database
value. Omitting the entire `jira:` stanza leaves the database untouched.
