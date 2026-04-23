# 0030 — Multi-Stage Docker Builds for Backend and Frontend

**Date:** 2026-04-23
**Status:** Accepted
**Deciders:** Architect Agent

## Context

The project is deployed to AWS App Runner via ECR-hosted container images. Both the
backend (NestJS) and frontend (Next.js) are Node.js applications that require a
compile step (`tsc`/`next build`) before they can run. Building and running in a
single Dockerfile layer leaves dev-only tooling, source files, and test fixtures
in the production image, increasing image size and attack surface.

---

## Options Considered

### Option A — Single-stage Dockerfile (selected against)

- Build and serve from one layer.
- **Pros:** Simple; one `RUN npm install && npm run build && node dist/main`.
- **Cons:** `node_modules` contains all dev dependencies; source files and TypeScript
  toolchain remain in the image; image is 3–5× larger than necessary; secrets baked
  in via `ARG` are visible in image history.

### Option B — Multi-stage Dockerfile (selected)

- **Backend:** two stages — `builder` (installs all deps, compiles TypeScript) and
  `runner` (copies only `dist/` and reinstalls production-only `node_modules` via
  `npm ci --omit=dev`).
- **Frontend:** three stages — `deps` (installs deps), `builder` (runs `next build`
  with `NEXT_PUBLIC_API_URL` baked in via `--build-arg`), and `runner` (copies only
  the Next.js standalone bundle, static assets, and `public/`).
- **Pros:** Production image contains only production artefacts; minimal attack surface;
  image size significantly smaller; `ARG` values are not persisted in the final layer.
- **Cons:** Slightly more complex Dockerfile; requires Docker BuildKit for efficient
  layer caching.

---

## Decision

> Both the backend and frontend use multi-stage Docker builds. The final production
> image contains only compiled output and production `node_modules`. Dev dependencies,
> source files, and build toolchain are discarded after the build stage.

---

## Rationale

Multi-stage builds are the industry-standard pattern for containerising compiled Node.js
applications. The reduction in image size directly improves ECR push/pull latency and
App Runner cold-start time. Excluding dev dependencies eliminates an entire class of
supply-chain vulnerability from the production image.

---

## Consequences

### Positive

- Production images contain only the artefacts needed at runtime.
- `NEXT_PUBLIC_API_URL` is passed as a `--build-arg` at image-build time, consistent
  with Next.js's requirement that public env vars be baked into the JS bundle.
- Image layers are ordered (package files → install → source → build) to maximise
  Docker layer-cache hit rate on source-only changes.
- The `ecr-push.sh` script forwards `--build-arg NEXT_PUBLIC_API_URL` automatically.

### Negative / Trade-offs

- `NEXT_PUBLIC_API_URL` is embedded in the bundle at build time; changing the API
  domain requires a new image build. This is acceptable for an internal tool with a
  stable domain.
- A separate image must be built for each target environment if `NEXT_PUBLIC_API_URL`
  differs between environments.

### Risks

- If `NEXT_TELEMETRY_DISABLED=1` is removed from the builder stage, the Next.js build
  will phone home to Vercel telemetry servers, which may fail in air-gapped pipelines.
  Both Dockerfiles set this variable explicitly.

---

## Related Decisions

- [ADR-0031](0031-nextjs-standalone-output.md) — Next.js standalone output mode, which
  determines what the frontend Dockerfile copies in its runner stage
- [ADR-0032](0032-nodejs-heap-cap-and-apprunner-instance-sizing.md) — Node.js heap cap
  and instance sizing, which constrains the memory available to the built images at runtime
