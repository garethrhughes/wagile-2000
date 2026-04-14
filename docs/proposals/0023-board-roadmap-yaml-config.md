# 0023 — Board and Roadmap Configuration via YAML Files

**Date:** 2026-04-14
**Status:** Accepted
**Author:** Architect Agent
**Related ADRs:** To be created upon acceptance

---

## Problem Statement

Board configuration (DORA rules, status names, Kanban thresholds) and roadmap
configuration (JPD project keys, custom date field IDs) are currently stored as
rows in two Postgres tables — `board_configs` and `roadmap_configs` — and managed
exclusively through the Settings UI and its CRUD REST endpoints. This approach has
three operational problems.

First, **initialising a new deployment is friction-heavy**. There is no way to
declare the intended configuration in source control. An operator must deploy the
backend, open the Settings UI, add each board one at a time, configure its twelve
fields individually, add each JPD key, and set the two custom field IDs per key.
Any mistake requires navigating back through the UI. There is no audit trail of
who changed what or why.

Second, **configuration drift across environments** (local dev, staging, production)
is invisible. Each environment holds its own `board_configs` and `roadmap_configs`
rows with no mechanism to verify they are in sync. Adding a new board in production
requires remembering to repeat the same UI steps in every other environment.

Third, **the current DB-primary write model conflicts with infrastructure-as-code
practices**. Teams that manage infrastructure via Git (Terraform, Helm, Docker
Compose files) expect configuration that lives in the repository, is reviewable via
pull request, and is applied deterministically on deployment.

This proposal does **not** affect metric calculation logic, Jira sync, or any API
endpoint used by metric pages. Only the management path for `board_configs` and
`roadmap_configs` changes.

---

## Proposed Solution

Introduce two YAML configuration files — `config/boards.yaml` and
`config/roadmap.yaml` — that define the full set of board configurations and
roadmap configurations respectively. A new `YamlConfigService` loads and validates
these files at application startup and seeds the `board_configs` and
`roadmap_configs` tables from them. The Postgres tables remain the live runtime
source of truth; YAML is the **declaration** layer that is applied on startup.
The Settings UI CRUD endpoints remain intact as an override mechanism for
operator-driven runtime changes.

### Guiding principle: YAML declares, Postgres runs

The YAML files are applied via a **upsert-on-startup** strategy:
- Boards present in YAML but absent from the database are inserted with YAML
  defaults.
- Boards present in both YAML and the database are updated to match YAML values
  (YAML wins on startup — see Migration Path for details on the opt-out mechanism).
- Boards present in the database but absent from YAML are left untouched (they may
  have been added at runtime via the Settings UI and are valid).
- The same three rules apply identically to roadmap configs.

This means YAML is **additive and declarative by default**: it never deletes
rows, it never blocks the UI from functioning, and it does not require a database
migration to add a new board — just editing the YAML file and restarting.

---

### 1. File locations and naming

```
backend/
  config/
    boards.yaml          # Board metric rule declarations
    roadmap.yaml         # JPD roadmap project declarations
    boards.example.yaml  # Annotated template (committed, safe to share)
    roadmap.example.yaml # Annotated template (committed, safe to share)
```

The `config/` directory lives under `backend/` rather than at the repo root because
it is a backend runtime artefact. It must **not** be committed to `.gitignore`
(the files contain no secrets). The `boards.yaml` and `roadmap.yaml` files for a
deployment may be committed to the repository or managed via a secrets/config
management system; this is the operator's choice.

---

### 2. YAML schema: `boards.yaml`

The file declares a top-level `boards` list. Every key maps 1:1 to a column on
`BoardConfig`. Unspecified keys fall back to entity-level defaults (the same
defaults used today when `createBoard()` creates a new row).

```yaml
# config/boards.yaml

boards:
  - boardId: ACC
    boardType: scrum
    doneStatusNames:
      - Done
      - Closed
      - Released
    inProgressStatusNames:
      - In Progress
      - In Development
    cancelledStatusNames:
      - Cancelled
      - "Won't Do"
    failureIssueTypes:
      - Bug
      - Incident
    failureLinkTypes:
      - "is caused by"
      - "caused by"
    failureLabels:
      - regression
      - incident
      - hotfix
    incidentIssueTypes:
      - Bug
      - Incident
    recoveryStatusNames:
      - Done
      - Resolved
    incidentLabels: []
    incidentPriorities:
      - Critical
    backlogStatusIds: []
    dataStartDate: null          # ISO YYYY-MM-DD or null

  - boardId: PLAT
    boardType: kanban
    doneStatusNames:
      - Done
      - Released
    inProgressStatusNames:
      - In Progress
    cancelledStatusNames:
      - Cancelled
    failureIssueTypes:
      - Bug
    failureLinkTypes:
      - "is caused by"
    failureLabels:
      - regression
    incidentIssueTypes:
      - Bug
    recoveryStatusNames:
      - Done
    incidentLabels: []
    incidentPriorities:
      - Critical
    backlogStatusIds:
      - "10303"
    dataStartDate: "2024-01-01"
```

**Design decisions:**

- `boardId` is the primary key. Duplicates within the file are rejected at
  validation time with a descriptive error.
- All twelve configurable fields are optional in the YAML. If a field is absent,
  the entity-level TypeORM default is used on insert; on upsert of an existing row,
  absent fields are left at their current database value (i.e. partial YAML is
  safe).
- String arrays use YAML sequences, not comma-separated values. This avoids the
  ambiguity of the `simple-array` TypeORM column type when values contain commas
  (e.g. `"Won't Do"`).
- `dataStartDate` accepts `null` or a quoted ISO date string. The YAML parser will
  read unquoted `null` as the JavaScript value `null`.

---

### 3. YAML schema: `roadmap.yaml`

```yaml
# config/roadmap.yaml

roadmaps:
  - jpdKey: DISC
    description: "Discovery roadmap"
    startDateFieldId: "customfield_10015"
    targetDateFieldId: "customfield_10021"

  - jpdKey: STRAT
    description: "Strategic initiatives"
    startDateFieldId: null
    targetDateFieldId: null
```

**Design decisions:**

- `jpdKey` is the primary key. Duplicates are rejected.
- `description`, `startDateFieldId`, and `targetDateFieldId` are optional. Absent
  fields default to `null` (matching the entity column defaults).
- Unlike board configs, `roadmapConfig` has an auto-generated numeric `id` primary
  key. On upsert, the match is by `jpdKey`, not by `id`. The `id` is never
  referenced in the YAML schema.

---

### 4. New module and service: `YamlConfigModule`

A new NestJS module is introduced. It has no external module dependencies and is
imported once by `AppModule`.

```
backend/src/yaml-config/
  yaml-config.module.ts
  yaml-config.service.ts
  yaml-config.service.spec.ts
  schemas/
    boards-yaml.schema.ts    # Zod or class-validator schema for boards.yaml
    roadmap-yaml.schema.ts   # Zod or class-validator schema for roadmap.yaml
```

#### `YamlConfigService` responsibilities

1. **Load** `config/boards.yaml` and `config/roadmap.yaml` from the filesystem at
   application startup (via NestJS `OnApplicationBootstrap` lifecycle hook).
2. **Validate** the parsed YAML against the declared schemas. Throw a fatal startup
   error if validation fails — the application must not start with invalid
   configuration. Log the specific field that failed validation.
3. **Upsert** board configs: for each entry in `boards.yaml`, call
   `boardConfigRepo.upsert()` with conflict target `boardId`.
4. **Upsert** roadmap configs: for each entry in `roadmap.yaml`, call
   `roadmapConfigRepo.upsert()` with conflict target `jpdKey`.
5. **Log** a startup summary: `N board configs applied, M roadmap configs applied`.

#### File resolution

The YAML file path is resolved relative to the process working directory (i.e.
`path.resolve(process.cwd(), 'config/boards.yaml')`). If a file does not exist,
`YamlConfigService` logs a warning and skips it — **absence of a YAML file is not
a fatal error**. This allows deployments that continue to use only the Settings UI
to operate unchanged.

#### Validation approach: Zod

Zod is chosen over `class-validator` for YAML schema validation for two reasons:
1. YAML-parsed objects are plain JavaScript objects, not class instances.
   `class-validator` requires instantiated classes decorated with validators;
   applying `plainToInstance` adds boilerplate.
2. Zod's error messages are precise (`Expected string, received number at
   boards[2].boardId`) and map naturally to the YAML structure without additional
   formatting.

A single `zod` dependency is added to `backend/package.json`. No other packages
are required. The `js-yaml` parser (for parsing YAML to JS objects) is also added
as it is the most widely used TypeScript-compatible YAML parser with type
definitions included.

```typescript
// backend/src/yaml-config/schemas/boards-yaml.schema.ts

import { z } from 'zod';

const BoardYamlSchema = z.object({
  boardId: z.string().min(1).toUpperCase(),
  boardType: z.enum(['scrum', 'kanban']),
  doneStatusNames: z.array(z.string()).optional(),
  inProgressStatusNames: z.array(z.string()).optional(),
  cancelledStatusNames: z.array(z.string()).optional(),
  failureIssueTypes: z.array(z.string()).optional(),
  failureLinkTypes: z.array(z.string()).optional(),
  failureLabels: z.array(z.string()).optional(),
  incidentIssueTypes: z.array(z.string()).optional(),
  recoveryStatusNames: z.array(z.string()).optional(),
  incidentLabels: z.array(z.string()).optional(),
  incidentPriorities: z.array(z.string()).optional(),
  backlogStatusIds: z.array(z.string()).optional(),
  dataStartDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
});

export const BoardsYamlFileSchema = z.object({
  boards: z.array(BoardYamlSchema),
}).superRefine((data, ctx) => {
  const seen = new Set<string>();
  data.boards.forEach((b, i) => {
    if (seen.has(b.boardId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Duplicate boardId "${b.boardId}" at index ${i}`,
        path: ['boards', i, 'boardId'],
      });
    }
    seen.add(b.boardId);
  });
});

export type BoardsYamlFile = z.infer<typeof BoardsYamlFileSchema>;
```

```typescript
// backend/src/yaml-config/schemas/roadmap-yaml.schema.ts

import { z } from 'zod';

const RoadmapYamlSchema = z.object({
  jpdKey: z.string().min(1),
  description: z.string().nullable().optional(),
  startDateFieldId: z.string().nullable().optional(),
  targetDateFieldId: z.string().nullable().optional(),
});

export const RoadmapYamlFileSchema = z.object({
  roadmaps: z.array(RoadmapYamlSchema),
}).superRefine((data, ctx) => {
  const seen = new Set<string>();
  data.roadmaps.forEach((r, i) => {
    if (seen.has(r.jpdKey)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Duplicate jpdKey "${r.jpdKey}" at index ${i}`,
        path: ['roadmaps', i, 'jpdKey'],
      });
    }
    seen.add(r.jpdKey);
  });
});

export type RoadmapYamlFile = z.infer<typeof RoadmapYamlFileSchema>;
```

#### `YamlConfigService` implementation sketch

```typescript
// backend/src/yaml-config/yaml-config.service.ts

import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import { BoardConfig, RoadmapConfig } from '../database/entities/index.js';
import { BoardsYamlFileSchema } from './schemas/boards-yaml.schema.js';
import { RoadmapYamlFileSchema } from './schemas/roadmap-yaml.schema.js';

@Injectable()
export class YamlConfigService implements OnApplicationBootstrap {
  private readonly logger = new Logger(YamlConfigService.name);

  constructor(
    @InjectRepository(BoardConfig)
    private readonly boardConfigRepo: Repository<BoardConfig>,
    @InjectRepository(RoadmapConfig)
    private readonly roadmapConfigRepo: Repository<RoadmapConfig>,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.applyBoardsYaml();
    await this.applyRoadmapYaml();
  }

  private async applyBoardsYaml(): Promise<void> {
    const filePath = path.resolve(process.cwd(), 'config/boards.yaml');
    if (!fs.existsSync(filePath)) {
      this.logger.log('config/boards.yaml not found — skipping board YAML seed.');
      return;
    }
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = yaml.load(raw);
    const result = BoardsYamlFileSchema.safeParse(parsed);
    if (!result.success) {
      // Fatal: misconfigured YAML must not silently pass
      const details = result.error.issues
        .map((i) => `  ${i.path.join('.')}: ${i.message}`)
        .join('\n');
      throw new Error(`boards.yaml validation failed:\n${details}`);
    }
    const { boards } = result.data;
    let applied = 0;
    for (const board of boards) {
      // Build upsert payload — only include fields explicitly specified in YAML
      // (undefined fields will not overwrite existing DB values in partial upserts).
      // TypeORM upsert with conflictPathsOrOptions will overwrite ALL provided columns.
      // We pass only the non-undefined fields.
      const payload: Partial<BoardConfig> = { boardId: board.boardId, boardType: board.boardType };
      if (board.doneStatusNames !== undefined) payload.doneStatusNames = board.doneStatusNames;
      if (board.inProgressStatusNames !== undefined) payload.inProgressStatusNames = board.inProgressStatusNames;
      if (board.cancelledStatusNames !== undefined) payload.cancelledStatusNames = board.cancelledStatusNames;
      if (board.failureIssueTypes !== undefined) payload.failureIssueTypes = board.failureIssueTypes;
      if (board.failureLinkTypes !== undefined) payload.failureLinkTypes = board.failureLinkTypes;
      if (board.failureLabels !== undefined) payload.failureLabels = board.failureLabels;
      if (board.incidentIssueTypes !== undefined) payload.incidentIssueTypes = board.incidentIssueTypes;
      if (board.recoveryStatusNames !== undefined) payload.recoveryStatusNames = board.recoveryStatusNames;
      if (board.incidentLabels !== undefined) payload.incidentLabels = board.incidentLabels;
      if (board.incidentPriorities !== undefined) payload.incidentPriorities = board.incidentPriorities;
      if (board.backlogStatusIds !== undefined) payload.backlogStatusIds = board.backlogStatusIds;
      if (board.dataStartDate !== undefined) payload.dataStartDate = board.dataStartDate ?? null;

      await this.boardConfigRepo.upsert(payload, { conflictPaths: ['boardId'] });
      applied++;
    }
    this.logger.log(`YAML config: ${applied} board config(s) applied from boards.yaml`);
  }

  private async applyRoadmapYaml(): Promise<void> {
    const filePath = path.resolve(process.cwd(), 'config/roadmap.yaml');
    if (!fs.existsSync(filePath)) {
      this.logger.log('config/roadmap.yaml not found — skipping roadmap YAML seed.');
      return;
    }
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = yaml.load(raw);
    const result = RoadmapYamlFileSchema.safeParse(parsed);
    if (!result.success) {
      const details = result.error.issues
        .map((i) => `  ${i.path.join('.')}: ${i.message}`)
        .join('\n');
      throw new Error(`roadmap.yaml validation failed:\n${details}`);
    }
    const { roadmaps } = result.data;
    let applied = 0;
    for (const roadmap of roadmaps) {
      const payload: Partial<RoadmapConfig> & { jpdKey: string } = {
        jpdKey: roadmap.jpdKey,
      };
      if (roadmap.description !== undefined) payload.description = roadmap.description ?? null;
      if (roadmap.startDateFieldId !== undefined) payload.startDateFieldId = roadmap.startDateFieldId ?? null;
      if (roadmap.targetDateFieldId !== undefined) payload.targetDateFieldId = roadmap.targetDateFieldId ?? null;

      // RoadmapConfig has an auto-generated numeric PK (id).
      // TypeORM upsert requires either the PK or a unique-constrained column
      // as the conflict path. jpdKey has a UNIQUE constraint.
      await this.roadmapConfigRepo.upsert(payload, { conflictPaths: ['jpdKey'] });
      applied++;
    }
    this.logger.log(`YAML config: ${applied} roadmap config(s) applied from roadmap.yaml`);
  }
}
```

---

### 5. Upsert semantics and YAML-wins policy

A **YAML-wins** policy is applied on startup: if a board or roadmap entry appears
in both the YAML file and the database, the YAML values overwrite the database
values for all fields that are explicitly specified in the YAML.

This is the correct default for a configuration-as-code approach: the file in the
repository is the authoritative declaration. If an operator makes a temporary
change via the Settings UI (e.g., adds a new `failureLabel` to test something)
and then wants to make it permanent, they update the YAML file and commit it.

**Escape hatch for pure UI-managed deployments:** An operator who does not want
YAML to overwrite UI-driven changes simply does not create the `config/boards.yaml`
or `config/roadmap.yaml` files. Because missing files are non-fatal and silently
skipped, purely UI-managed deployments continue to work exactly as they do today.

**Partial YAML is safe:** Fields absent from a YAML entry (not `null`, but entirely
absent from the document) are not included in the upsert payload and will not
overwrite existing database values. This allows YAML to manage a subset of fields
while leaving others under UI control.

---

### 6. Hot-reload (not implemented in v1)

File-watching (inotify / `fs.watch`) for hot-reload of YAML changes without restart
is explicitly **out of scope for this proposal**. The operational cost of a service
restart to apply a configuration change is low — the application starts in seconds
— and the added complexity of a file watcher (race conditions, partial reads,
re-entrant upsert logic) is not justified for an internal tool. Hot-reload can be
added as a follow-up proposal if operational need arises.

---

### 7. New `GET /api/config/yaml-status` endpoint (optional)

To give operators visibility into whether the YAML seed was applied successfully
without reading log output, `YamlConfigService` exposes a summary of the last
startup seed result that `AppConfigModule`'s `ConfigController` can serve:

```typescript
// Added to ConfigController:
@Get('yaml-status')
@ApiOperation({ summary: 'Returns the result of the last YAML config seed' })
getYamlStatus(): YamlSeedStatus {
  return this.yamlConfigService.getLastSeedStatus();
}
```

```typescript
interface YamlSeedStatus {
  boardsFileFound: boolean;
  boardsApplied: number;
  roadmapFileFound: boolean;
  roadmapsApplied: number;
  lastAppliedAt: string | null; // ISO timestamp of last successful startup seed
  error: string | null;
}
```

This endpoint is informational and read-only. It requires no authentication beyond
what the existing API guards provide (currently none — see proposal 0009). Marking
this as optional because it adds implementation scope; the core proposal is
complete without it.

---

### 8. Data flow after this change

```
Application startup
  │
  └─► YamlConfigService.onApplicationBootstrap()
        │
        ├─► fs.existsSync('config/boards.yaml')
        │     ├─ absent → log warning, skip
        │     └─ present →
        │           js-yaml.load() → plain JS object
        │           BoardsYamlFileSchema.safeParse()
        │             ├─ invalid → throw Error (startup fails with readable message)
        │             └─ valid →
        │                 for each board:
        │                   boardConfigRepo.upsert({ boardId, ... }, ['boardId'])
        │                   (INSERT … ON CONFLICT (board_id) DO UPDATE SET …)
        │
        └─► (same pattern for config/roadmap.yaml → roadmapConfigRepo.upsert([jpdKey]))


Runtime (Settings UI — unchanged flow)
  │
  ├─► PUT /api/boards/:boardId/config  → boardConfigRepo.save()
  │     └─► DB row updated; YAML file unchanged
  │           NOTE: on next restart, YAML will re-apply and overwrite
  │           this change IF the field is present in the YAML file.
  │           Operators should update the YAML file to make changes permanent.
  │
  └─► PATCH /api/roadmap/configs/:id  → roadmapConfigRepo.save()
        └─► same caveat applies


All metric services (unchanged)
  │
  └─► Read from board_configs / roadmap_configs Postgres tables
        (identical to today — no code changes in any metric service)
```

---

### 9. New files and changed files

| File | Change |
|---|---|
| `backend/src/yaml-config/yaml-config.module.ts` | **New** — NestJS module |
| `backend/src/yaml-config/yaml-config.service.ts` | **New** — startup upsert logic |
| `backend/src/yaml-config/yaml-config.service.spec.ts` | **New** — unit tests |
| `backend/src/yaml-config/schemas/boards-yaml.schema.ts` | **New** — Zod schema |
| `backend/src/yaml-config/schemas/roadmap-yaml.schema.ts` | **New** — Zod schema |
| `backend/src/app.module.ts` | Add `YamlConfigModule` to imports |
| `backend/src/config/config.controller.ts` | Add `GET /api/config/yaml-status` *(optional)* |
| `backend/config/boards.example.yaml` | **New** — annotated template |
| `backend/config/roadmap.example.yaml` | **New** — annotated template |
| `backend/package.json` | Add `zod` and `js-yaml` (+ `@types/js-yaml`) to dependencies |
| `.gitignore` | Confirm `config/boards.yaml` and `config/roadmap.yaml` are **not** ignored |
| `backend/.env.example` | Add comment directing operators to `config/boards.example.yaml` |

No changes to:
- Any entity file or migration
- Any metric service, planning service, roadmap service, or sync service
- Any controller beyond `ConfigController` (optional)
- Any frontend file

---

## Alternatives Considered

### Alternative A — Replace Postgres with YAML as the sole runtime source of truth

Remove `board_configs` and `roadmap_configs` tables entirely. All services read
configuration directly from the YAML files at request time (via a cached
in-memory representation loaded by `YamlConfigService`).

**Why considered:** Eliminates the dual-write concern (YAML vs DB). Configuration
is purely file-driven.

**Why ruled out:** This is a breaking change to the entire data model. Every
service that currently reads `boardConfigRepo` or `roadmapConfigRepo` would need
to be rewritten to call `YamlConfigService` instead. The entity relationship between
`board_configs` and `jira_issues` (via `boardId`) cannot be enforced as a foreign
key without a Postgres row. More critically, the Settings UI, which allows runtime
changes without a file edit or restart, would cease to function. The dual-layer
approach (YAML declares, Postgres runs) preserves all existing behaviour and adds
the file-driven initialisation path without any schema changes.

### Alternative B — JSON files instead of YAML

Use `config/boards.json` and `config/roadmap.json`, eliminating the `js-yaml`
dependency.

**Why considered:** Reduces dependencies. JSON is natively parseable in Node.js
(`JSON.parse`). TypeScript types can be asserted directly.

**Why ruled out:** JSON does not support comments, which are essential for
annotated example files (the primary operator-facing document). YAML's multi-line
string and null handling is also more ergonomic for lists of status names. The
`js-yaml` package is 30 kB and battle-tested. The operational readability benefit
of YAML over JSON for human-edited configuration files justifies the one additional
dependency.

### Alternative C — `@nestjs/config` custom configuration factory

Use the existing `ConfigModule.forRoot({ load: [...] })` pattern to load YAML
files as a custom config factory, integrating with the existing `ConfigService`.

**Why considered:** No new module required; plays within the existing NestJS
config infrastructure.

**Why ruled out:** `@nestjs/config` custom factories are designed for environment-
level application configuration (connection strings, feature flags), not for
structured data that must be persisted to a database. The upsert-to-Postgres
step cannot be performed inside a `ConfigModule.forRoot({ load })` factory (no
repository access at that lifecycle stage). Forcing the pattern would require
using a `DynamicModule.register()` approach that is harder to test and less
idiomatic than a simple `OnApplicationBootstrap` service.

### Alternative D — Environment variable with JSON payload

Allow `BOARD_CONFIG_JSON` and `ROADMAP_CONFIG_JSON` environment variables that
accept the full configuration as an inline JSON string.

**Why considered:** Works with existing `ConfigService` machinery. No new files
or dependencies.

**Why ruled out:** Environment variables are not designed for multi-kilobyte
structured payloads. They are opaque to diff tools, cannot be linted, cannot
contain comments, and are cumbersome to edit. This approach solves deployment
friction by replacing one opaque mechanism (the UI) with another (a JSON blob
in an env var). It has no operational advantages over YAML files.

### Alternative E — Database seed scripts (SQL or TypeScript migration)

Provide example SQL `INSERT` statements or a TypeORM migration that seeds default
board and roadmap configurations on first install.

**Why considered:** Uses existing database migration tooling; no new dependencies.

**Why ruled out:** Migrations are append-only and reversible by design. They run
once per deployment and cannot update values on subsequent deployments (without
tricks like conditional inserts or version tables). They also require re-running
the migration pipeline to change configuration, which is more friction than editing
a YAML file. Migrations are appropriate for schema changes, not for per-deployment
configuration data that evolves independently of the schema.

---

## Impact Assessment

| Area | Impact | Notes |
|---|---|---|
| Database | None — no schema change | All tables remain unchanged. Upsert uses existing columns and constraints. The `boardId` column in `board_configs` has a primary key constraint (used as conflict target). The `jpdKey` column in `roadmap_configs` has a UNIQUE constraint (used as conflict target). |
| API contract | Additive only | `GET /api/config/yaml-status` is a new optional endpoint. All existing endpoints are unchanged. |
| Backend modules | New module | `YamlConfigModule` added. `AppModule` gains one import. No existing module changed. |
| Metric services | None | `BoardsService`, `RoadmapService`, and all metric calculation services are unchanged. They continue to read from Postgres repositories. |
| Settings UI | None | All Settings UI CRUD flows remain intact. The YAML upsert runs at startup only; it does not intercept or replace UI-driven API calls. |
| Frontend | None | No frontend changes required. |
| Migrations | None | No new migration. Upsert is a DML operation on existing schema. |
| New dependencies | 2 runtime deps | `zod` (schema validation), `js-yaml` + `@types/js-yaml` (YAML parsing). Total size: ~150 kB. Both are stable, widely adopted packages. |
| Jira API | No new calls | YAML loading and DB upsert are purely local operations. |
| Tests | New unit tests | `YamlConfigService` spec covering: valid YAML loads and upserts; missing file is a no-op; invalid YAML throws startup error; duplicate boardId is rejected; partial YAML (absent optional fields) does not overwrite DB values. |
| Startup time | Negligible increase | File read + Zod parse + N upserts: < 50 ms for a typical board count (≤ 10). |

---

## Open Questions

1. **YAML-wins vs UI-wins for runtime changes.** The proposal defaults to YAML-wins
   on startup: if a board is in the YAML file and the operator has edited its fields
   via the UI, those UI-driven changes will be overwritten at the next restart. Is
   this the correct default? An alternative is **UI-wins** (YAML only seeds rows that
   don't yet exist, never updating existing rows). The trade-off: YAML-wins gives
   consistent declarative behaviour and prevents configuration drift; UI-wins gives
   operators freedom to diverge from the YAML without being reset. This proposal
   recommends YAML-wins because it aligns with infrastructure-as-code expectations,
   but the implementation can be toggled by changing `upsert()` to
   `save({ ...defaults, ...existing })` on the board-absent path only.

2. **File location flexibility.** The proposal hardcodes `config/boards.yaml`
   relative to `process.cwd()`. Should an environment variable
   (e.g. `BOARD_CONFIG_FILE`, `ROADMAP_CONFIG_FILE`) be supported to allow the
   operator to place the files elsewhere (e.g., in a Kubernetes ConfigMap mounted at
   `/etc/app/boards.yaml`)? The added flexibility is low cost but adds two env vars.
   Recommend adding the env vars as overrides with `config/boards.yaml` as the
   default.

3. **Deletion semantics.** If a board is removed from `boards.yaml`, it is *not*
   deleted from the database (the YAML never deletes rows). Is this the correct
   behaviour? The rationale matches the orphaned-data decision in proposal 0016:
   removing a board's *configuration* is different from *purging its data*, and the
   latter should be a deliberate UI action, not a side-effect of editing a YAML file.
   Confirm this is acceptable or whether a `yaml-delete: true` flag per entry is
   wanted.

4. **`boardId` normalisation.** The Zod schema applies `.toUpperCase()` to `boardId`
   values parsed from YAML, matching the normalisation in `BoardsService.createBoard()`.
   If a YAML file contains `boardId: acc`, should it be silently normalised to `ACC`
   or should it be rejected as invalid? Silent normalisation is more forgiving;
   rejection-with-message is more predictable. The current schema applies silent
   normalisation.

5. **`js-yaml` vs `yaml` package.** Two popular YAML parsers exist in the Node.js
   ecosystem: `js-yaml` (the long-established choice, ~30 kB) and `yaml` (newer,
   ~80 kB, full YAML 1.2). Both are safe. This proposal recommends `js-yaml` for its
   smaller footprint and established track record. Confirm or override.

---

## Migration Path from Current Config to YAML

### For existing deployments

No action is required. If `config/boards.yaml` does not exist, the service starts
exactly as before — the YAML layer is completely inactive. Operators can introduce
YAML gradually by creating the files and populating them from the current Settings
UI values (which they can read via `GET /api/boards` and `GET /api/roadmap/configs`).

A helper CLI script (`scripts/export-config-to-yaml.ts`) may be provided (not in
scope for this proposal) that calls the local API and generates YAML output to
stdout, making the migration trivial:

```bash
npx ts-node scripts/export-config-to-yaml.ts > backend/config/boards.yaml
```

### For new deployments

1. Copy `config/boards.example.yaml` to `config/boards.yaml`.
2. Edit the `boards` list to declare each board.
3. Copy `config/roadmap.example.yaml` to `config/roadmap.yaml`.
4. Edit the `roadmaps` list to declare each JPD project key and field IDs.
5. Start the application. `YamlConfigService` seeds the database on first boot.
6. Verify via `GET /api/boards` or the Settings UI that all boards are present.

No manual UI steps required for initial configuration.

---

## Acceptance Criteria

**`YamlConfigService` — core behaviour**

- [ ] `onApplicationBootstrap()` is called on application startup. It does not
      block the NestJS bootstrap lifecycle beyond the time required for file I/O
      and upsert queries.

- [ ] If `config/boards.yaml` is absent, `YamlConfigService` logs a `warn`-level
      message ("config/boards.yaml not found — skipping board YAML seed.") and
      exits without error. The application starts normally.

- [ ] If `config/roadmap.yaml` is absent, the same no-op behaviour applies.

- [ ] If `config/boards.yaml` exists and is valid, `YamlConfigService` upserts
      all declared boards into `board_configs` using `boardId` as the conflict
      target. Existing rows are updated with the YAML values for all specified
      fields.

- [ ] If `config/roadmap.yaml` exists and is valid, `YamlConfigService` upserts
      all declared roadmap configs into `roadmap_configs` using `jpdKey` as the
      conflict target.

- [ ] A board present in the database but absent from `boards.yaml` is **not**
      deleted or modified.

- [ ] A roadmap config present in the database but absent from `roadmap.yaml` is
      **not** deleted or modified.

**Validation**

- [ ] If `config/boards.yaml` contains a `boardId` value that fails Zod validation
      (e.g., empty string, non-string type), the application fails to start with a
      logged error message that includes the file path and the failing field's dot-
      notation path (e.g., `boards[1].boardId: Expected string, received number`).

- [ ] If `config/boards.yaml` contains duplicate `boardId` values, the application
      fails to start with a message identifying the duplicate and its index.

- [ ] An empty `boards: []` list is valid and results in no upserts.

- [ ] `boardType` must be `"scrum"` or `"kanban"`. Any other value causes a fatal
      startup error.

- [ ] `dataStartDate` must be `null` or a string matching `YYYY-MM-DD`. Any other
      format causes a fatal startup error.

**Partial YAML**

- [ ] A board entry that omits optional fields (e.g., no `failureLabels` key at all)
      does not overwrite the existing `failureLabels` value in the database.

- [ ] A board entry that explicitly sets a field to `null` where the schema permits
      (e.g., `dataStartDate: null`) writes `null` to the database.

**Module integration**

- [ ] `YamlConfigModule` is imported in `AppModule`. No circular dependency is
      introduced.

- [ ] `YamlConfigService` is injectable and its `onApplicationBootstrap()` is
      called exactly once per process startup.

- [ ] Adding `zod` and `js-yaml` to `backend/package.json` does not break the
      existing build or test suite.

**Documentation**

- [ ] `backend/config/boards.example.yaml` exists, contains annotated comments for
      every supported field, and includes at least two example board entries (one
      scrum, one kanban).

- [ ] `backend/config/roadmap.example.yaml` exists with analogous annotation.

- [ ] `backend/.env.example` includes a comment directing operators to
      `config/boards.example.yaml` for configuration.

- [ ] `docs/proposals/README.md` is updated to include this proposal.

**Tests**

- [ ] Unit tests for `YamlConfigService` cover: valid boards YAML seeds correctly;
      valid roadmap YAML seeds correctly; missing file is a no-op; invalid YAML
      (bad boardType) throws on startup; duplicate boardId throws on startup;
      partial YAML entry (absent optional field) does not include that field in the
      upsert payload; `boards: []` results in zero upserts.

- [ ] No existing test is broken by the introduction of `YamlConfigModule`.
