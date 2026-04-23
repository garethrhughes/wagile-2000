# 0031 — Next.js Standalone Output Mode

**Date:** 2026-04-23
**Status:** Accepted
**Deciders:** Architect Agent

## Context

The frontend is a Next.js 16 application deployed as a container on AWS App Runner.
Next.js supports several output modes that determine what files the production server
requires at runtime. The choice of output mode directly affects image size, cold-start
time, and the Dockerfile structure needed for a minimal production image.

---

## Options Considered

### Option A — Default output (no `output` setting)

- Next.js copies the full `node_modules` tree into `.next/` and requires the entire
  project directory to be present at runtime.
- **Pros:** Zero configuration; works out of the box.
- **Cons:** The production Docker image must include all `node_modules` (including
  transitive deps used only for `next build`); image size is large; not well-suited
  to multi-stage builds without manual pruning.

### Option B — `output: 'export'` (static HTML export)

- Produces a fully static site with no server-side rendering or API routes.
- **Pros:** Can be served from S3/CloudFront directly; no Node.js process needed.
- **Cons:** Incompatible with App Router server components, server actions, and
  App Router API routes (needed for the health endpoint). Ruled out.

### Option C — `output: 'standalone'` (selected)

- Next.js analyses imports and emits a minimal self-contained bundle at
  `.next/standalone/` containing only the files actually used at runtime.
- A minimal `server.js` is emitted that boots a standard Node.js HTTP server.
- **Pros:** Dramatically smaller runtime footprint; no `node_modules` directory in the
  production image — only the traced subset is included in `standalone/`; compatible
  with App Router API routes; aligns with official Next.js Docker deployment guidance.
- **Cons:** Requires explicitly copying `.next/static/` and `public/` alongside the
  standalone bundle (they are not included automatically).

---

## Decision

> The frontend uses `output: 'standalone'` in `next.config.mjs`. The production Docker
> image copies only `.next/standalone/`, `.next/static/`, and `public/` from the build
> stage, resulting in a minimal self-contained image that runs via `node server.js`.

---

## Rationale

`output: 'standalone'` is the only mode that is simultaneously compatible with App Router
API routes, produces a minimal runtime image, and is recommended by the Next.js team for
containerised deployments. The static export mode is incompatible with the health endpoint
and any future server-side data fetching.

---

## Consequences

### Positive

- Production image size is substantially reduced compared to shipping full `node_modules`.
- The runner stage Dockerfile is clean: three `COPY` instructions cover everything needed.
- App Runner's health checker can reach `GET /api/health` via the Next.js server.

### Negative / Trade-offs

- `public/` and `.next/static/` must be copied separately. If a developer adds a new
  build output directory in the future, they must remember to add a `COPY` instruction
  to the runner stage.
- The standalone server does not support `next dev` hot reload; this is development-only
  and is irrelevant for the production image.

### Risks

- Next.js's standalone trace is based on static import analysis. Dynamic `require()` calls
  or runtime `fs.readFile` of files outside the trace may fail silently in production. Any
  YAML config files that must be present at runtime (e.g. `boards.yaml`) must be explicitly
  included in the runner image or verified against the standalone trace.

---

## Related Decisions

- [ADR-0030](0030-multi-stage-docker-builds.md) — Multi-stage Docker builds that rely on
  the standalone output to define what gets copied into the runner stage
