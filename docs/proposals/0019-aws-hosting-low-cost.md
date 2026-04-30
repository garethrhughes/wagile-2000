# 0019 — AWS Hosting (Minimum Cost)

## Status

Proposed

## Context

The Jira DORA & Planning Metrics Dashboard is an internal engineering tool used by a small team.
It consists of:

- **Frontend:** Next.js 16 (App Router, SSR + static pages)
- **Backend:** NestJS 11 (REST API, scheduled Jira sync once daily at midnight, TypeORM)
- **Database:** PostgreSQL 16
- **Auth:** Single static API key (no OAuth, no user management)
- **Traffic:** Low — handful of engineers, not public-facing

The goal is to host this on AWS at the lowest possible recurring cost while keeping the
application fully functional. AWS Free Tier is **not** available on this account.

---

## Proposed Architecture

```
┌─────────────────────────────────────────────────────────┐
│                        Internet                         │
└─────────────────────┬───────────────────────────────────┘
                      │
              ┌───────▼────────┐
              │  Route 53 (DNS) │  ~$0.50/mo (hosted zone)
              └───────┬────────┘
                      │
        ┌─────────────┴─────────────┐
        │                           │
┌───────▼──────────┐     ┌──────────▼──────────┐
│  App Runner      │     │    App Runner        │
│  (Next.js SSR)   │     │    (NestJS API)      │
└──────────────────┘     └──────────┬──────────┘
                                    │  IAM auth token
                         ┌──────────▼──────────┐
                         │  Aurora DSQL         │
                         │  (serverless,        │
                         │   scales to zero)    │
                         └─────────────────────┘
```

### Component Decisions

| Component | Service | Reason |
|---|---|---|
| Frontend (Next.js) | **AWS App Runner** | `next start` runs as a Node process; no Amplify needed; same deployment model as the backend |
| Backend (NestJS) | **AWS App Runner** | Runs containers, scales to near-zero, ~$3–6/mo at low traffic |
| Database | **Aurora DSQL** | Serverless, scales to zero — no hourly instance charge when idle |
| Container Registry | **ECR** | $0.10/GB-month; one repo per service |
| DNS | **Route 53** | $0.50/mo per hosted zone |
| Secrets | **SSM Parameter Store** | Standard parameters are free |

---

## Cost Breakdown (Monthly Estimates, No Free Tier)

All prices are us-east-1, on-demand, as of 2026. Assumes ~5 active users, light traffic,
services idle most of the day.

| Service | Config | Est. Cost |
|---|---|---|
| **App Runner** (frontend) | 0.25 vCPU / 0.5 GB; paused when idle | **~$2–4/mo** |
| **App Runner** (backend) | 0.25 vCPU / 0.5 GB; paused when idle | **~$3–6/mo** |
| **Aurora DSQL** (database) | DPU: $8/million; Storage: $0.33/GB-month; ~5 GB data, low query volume | **~$2–5/mo** |
| **ECR** | ~300 MB per image × 2; $0.10/GB-month | **~$0.06/mo** |
| **SSM Parameter Store** | Standard parameters | **$0** |
| **Route 53** | 1 hosted zone + queries | **~$1/mo** |
| **Data Transfer** | Minimal outbound | **~$1/mo** |
| **Total** | | **~$9–16/mo** |

The frontend App Runner service runs `next start` and serves SSR pages directly — no CDN in
front by default, which is fine for a low-traffic internal tool. CloudFront could be added later
for ~$0.01–0.02/mo at this scale if caching becomes desirable.

### Why Aurora DSQL beats RDS here

RDS `db.t4g.micro` costs ~$13/mo regardless of whether it is used or not — it runs 24/7.
Aurora DSQL charges only for DPUs consumed and storage. For an internal dashboard that is
mostly idle, the effective database cost drops to **storage + light query charges** (~$2–5/mo).

### RDS comparison (for reference)

| Option | Monthly cost | Notes |
|---|---|---|
| RDS `db.t4g.micro` Single-AZ | ~$13 | Always-on instance charge |
| Aurora Serverless v2 | ~$10–20 | Minimum 0.5 ACU floor even at idle |
| **Aurora DSQL** | **~$2–5** | True scale-to-zero; only pay for activity + storage |

## Aurora DSQL — Compatibility Caveats

Aurora DSQL is PostgreSQL-wire-protocol compatible and works with the `pg` driver and TypeORM,
but it has architectural differences that require changes to this codebase before deploying.

### Authentication

DSQL does **not** use a static password. It requires a short-lived IAM authentication token
generated via AWS SDK (Signature V4). The token is passed as the `password` field on connection.
Tokens expire; connections must be refreshed periodically (max session duration: 1 hour).

**Required change:** Replace the static `DATABASE_URL` with a custom TypeORM `DataSource`
factory that generates a fresh token on each connection using `@aws-sdk/dsql-signer`:

```typescript
import { DsqlSigner } from '@aws-sdk/dsql-signer'

async function getDsqlPassword(): Promise<string> {
  const signer = new DsqlSigner({
    hostname: process.env.DSQL_ENDPOINT,
    region: process.env.AWS_REGION,
  })
  return signer.getDbConnectAdminAuthToken()
}
```

TypeORM's `DataSource` accepts a `password` factory function, so this integrates cleanly.

### No Foreign Key Constraint Enforcement

DSQL supports FK syntax in DDL but does **not** enforce referential integrity at the database
level. Any FK constraints in TypeORM entity definitions will be accepted by the migration runner
but silently not enforced.

**Impact:** Low for this codebase — the app already owns all writes and the relationships are
straightforward (e.g. `JiraIssue → JiraSprint`). Application-layer integrity is sufficient.

### DDL and DML Cannot Mix in One Transaction

DSQL requires DDL statements (e.g. `CREATE TABLE`, `ALTER TABLE`) to run in a separate
transaction from DML (`INSERT`, `UPDATE`, `DELETE`).

**Impact:** TypeORM migrations run DDL in their own `queryRunner` transactions, which already
matches this constraint. However, any migration that mixes DDL + seed data in one transaction
must be split into two separate migrations.

### No TRUNCATE

TypeORM occasionally emits `TRUNCATE` for test fixtures or seed scripts. Replace with
`DELETE FROM table_name` in any seed or test-setup code.

### 3,000-Row DML Limit Per Transaction

A single transaction can modify at most 3,000 rows across all statements. The Jira sync
service batch-inserts issues and changelog entries; ensure batches stay within this limit.

**Required change:** Chunk bulk inserts in the sync service:

```typescript
// Instead of one large save():
const BATCH_SIZE = 500
for (let i = 0; i < issues.length; i += BATCH_SIZE) {
  await queryRunner.manager.save(issues.slice(i, i + BATCH_SIZE))
  // each save() runs in its own transaction
}
```

### No PL/pgSQL or Stored Procedures

Not used in this codebase — no impact.

### Optimistic Concurrency Control (OCC)

DSQL uses OCC instead of row-level locking. Concurrent writes to the same rows result in a
serialization error rather than a blocked wait. The NestJS sync service runs on a daily
cron and is effectively single-writer, so conflict probability is very low. Add retry logic
on `40001` (serialization failure) errors as a precaution.

### Sequences and Identity Columns

DSQL supports `GENERATED BY DEFAULT AS IDENTITY` (used by TypeORM's `@PrimaryGeneratedColumn()`).
Sequential IDs are supported but DSQL recommends UUID primary keys for optimal distribution.
No immediate change required, but UUIDs would be preferable for new entities.

## Deployment Strategy

### Frontend (Next.js → App Runner)

Add a `Dockerfile` to `frontend/`:

```dockerfile
FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine
WORKDIR /app
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
EXPOSE 3000
CMD ["node", "server.js"]
```

> Requires `output: 'standalone'` in `next.config.ts` to produce a self-contained server bundle.

Set `NEXT_PUBLIC_API_BASE_URL` to the backend App Runner service URL as an environment variable
on the frontend App Runner service.

### Backend (NestJS → App Runner)

1. Add a `Dockerfile` to `backend/`:

```dockerfile
FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
EXPOSE 3001
CMD ["node", "dist/main"]
```

2. Push image to ECR on deploy (GitHub Actions).
3. App Runner pulls from ECR. Grant the App Runner IAM task role `dsql:DbConnectAdmin`
   on the DSQL cluster ARN so the NestJS process can generate auth tokens.
4. Run migrations as a pre-deploy step (see below).

### Frontend (Next.js → App Runner)

Already covered above — same ECR push + App Runner deploy pattern as the backend.

### Database Migrations

DSQL requires DDL and DML in separate transactions. TypeORM migrations already satisfy this
since each migration method runs in its own `queryRunner` transaction. Run migrations as a
one-off GitHub Actions step before updating the App Runner service:

```bash
# CI step: assumes DSQL_ENDPOINT and AWS credentials are set in the runner environment
npm run migration:run
```

The custom `DataSource` factory (see Compatibility section) must be used here too — the
migration runner needs to generate an IAM token rather than use a static password.

---

## Environment Variables

With DSQL, there is no static database password. Replace `DATABASE_URL` with endpoint + region,
and let the app generate tokens at runtime via the IAM role. All other secrets remain in
**SSM Parameter Store** (standard parameters are free).

| Variable | SSM Path | Notes |
|---|---|---|
| `DSQL_ENDPOINT` | `/fragile/prod/DSQL_ENDPOINT` | e.g. `abc123.dsql.us-east-1.on.aws` |
| `AWS_REGION` | set by App Runner automatically | No SSM entry needed |
| `APP_API_KEY` | `/fragile/prod/APP_API_KEY` | |
| `JIRA_BASE_URL` | `/fragile/prod/JIRA_BASE_URL` | |
| `JIRA_USER_EMAIL` | `/fragile/prod/JIRA_USER_EMAIL` | |
| `JIRA_API_TOKEN` | `/fragile/prod/JIRA_API_TOKEN` | |
| `JIRA_BOARD_IDS` | `/fragile/prod/JIRA_BOARD_IDS` | |

---

## Infrastructure as Code

Use **AWS CDK (TypeScript)** — consistent with the existing TypeScript stack.

Suggested stack layout:

```
infra/
  bin/
    app.ts
  lib/
    database-stack.ts   # Aurora DSQL cluster, IAM policies
    backend-stack.ts    # ECR repo + App Runner service for NestJS, IAM task role
    frontend-stack.ts   # ECR repo + App Runner service for Next.js
    dns-stack.ts        # Route 53 hosted zone + records (optional)
```

DSQL is serverless — the CDK resource is simply `new aws_dsql.CfnCluster(...)` with no
instance sizing, storage allocation, or VPC configuration required. Both App Runner services
follow the same pattern, keeping the CDK code uniform and easy to maintain.

---

## Trade-offs

| Decision | Pro | Con |
|---|---|---|
| Aurora DSQL over RDS | True scale-to-zero; ~$2–5/mo vs ~$13/mo | Requires IAM token auth; FK constraints not enforced; 3k-row tx limit |
| App Runner over ECS Fargate | No cluster/ALB to manage; cheaper at low traffic | Cold starts ~5–10s; less control |
| App Runner for frontend over Amplify | Uniform deployment model; no Amplify-specific build config; GitHub Actions already owned | No built-in CDN; cold starts apply to SSR pages too |
| No VPC / NAT Gateway | Saves ~$32/mo | DSQL accessed over HTTPS (not VPC-peered); App Runner internet-facing |
| No ElastiCache | Saves ~$13/mo | No in-memory cache; acceptable for this workload |

### No VPC Needed for DSQL

Unlike RDS, Aurora DSQL does **not** live inside your VPC. It is accessed over a public HTTPS
endpoint using IAM token authentication. This eliminates the need for VPC connectors, NAT
Gateways, or subnet groups — saving ~$32/mo and significant infra complexity.

---

## Cost Optimisation Tips

1. **Aurora DSQL scales to zero automatically** — idle time costs nothing beyond storage ($0.33/GB-month).
2. **Both App Runner services at `minSize=0`** — services pause when not receiving traffic; cold start of ~5–10s is acceptable for an internal tool.
3. **ECR lifecycle policy** — expire untagged images after 7 days to avoid accumulating storage charges.
4. **No CDN needed** — at this traffic level CloudFront adds complexity for negligible saving. Add it later if needed.
5. **AWS Budgets** — set a $20/mo alert to catch any unexpected usage early.
6. **DSQL DPU monitoring** — watch `ComputeDPU`, `ReadDPU`, `WriteDPU` in CloudWatch; the 30-min Jira sync is the dominant write load.

---

## Required Code Changes Summary

| Change | Effort |
|---|---|
| Add `output: 'standalone'` to `next.config.ts` | Trivial |
| Add `frontend/Dockerfile` using standalone output | Trivial |
| Replace static DB password with DSQL IAM token factory in `data-source.ts` | Small |
| Add `@aws-sdk/dsql-signer` dependency to backend | Trivial |
| Chunk bulk inserts in sync service to ≤500 rows per transaction | Small |
| Replace any `TRUNCATE` calls in seeds/tests with `DELETE FROM` | Trivial |
| Split any migration that mixes DDL + DML into two separate migrations | Small |
| Add `dsql:DbConnectAdmin` IAM policy to App Runner task role (backend) | Infra only |

---

## Recommended Next Steps

1. Add `output: 'standalone'` to `next.config.ts` and add `frontend/Dockerfile`.
2. Add `backend/Dockerfile`.
3. Add `@aws-sdk/dsql-signer` to backend dependencies and update `data-source.ts` to use token auth.
4. Audit sync service bulk inserts; add 500-row chunking where needed.
5. Create `infra/` CDK project with `database-stack.ts`, `backend-stack.ts`, and `frontend-stack.ts`.
6. Add GitHub Actions workflow: build & push both ECR images → run migrations → deploy both App Runner services.
7. Migrate secrets to SSM Parameter Store.
