# 0036 — `POST /api/sync` as Fire-and-Forget Returning HTTP 202

**Date:** 2026-04-23
**Status:** Accepted
**Deciders:** Architect Agent

## Context

`POST /api/sync` triggers a full sync of all configured boards. A full sync fetches
issues and changelogs from Jira for every board, which involves hundreds of HTTP requests
to the Jira API and takes several minutes to complete. The sync endpoint was originally
implemented as `async triggerSync() { return this.syncService.syncAll(); }`, meaning
the HTTP response was held open until the entire sync completed.

With CloudFront in front of App Runner (ADR-0033), this pattern is incompatible:
CloudFront enforces a 60-second origin response timeout. A sync that takes more than
60 seconds receives a `504 Gateway Timeout` from CloudFront even if the App Runner
service is still working correctly. The client would receive an error even on a
successful sync.

---

## Options Considered

### Option A — Keep synchronous response; raise CloudFront timeout

- CloudFront distributions support a configurable origin response timeout (up to 60
  seconds for standard distributions; up to 180 seconds via a support ticket).
- **Pros:** No code change; sync result returned in the response body.
- **Cons:** 180 seconds is still insufficient for large deployments; requires an AWS
  support request to raise the limit; couples HTTP response lifetime to sync duration;
  if the connection drops mid-sync, the client cannot distinguish success from failure.
  Ruled out as a fragile solution.

### Option B — Fire-and-forget returning HTTP 202 Accepted (selected)

- `triggerSync()` is changed to a non-`async` controller method. It calls
  `this.syncService.syncAll()` without `await`, attaches a `.catch()` handler for
  unexpected top-level rejections, and immediately returns `{ status: 'accepted' }` with
  HTTP 202. The client polls `GET /api/sync/status` to observe progress.
- **Pros:** The HTTP response is returned well within CloudFront's 60-second timeout;
  sync runs to completion regardless of client connection state; semantically correct
  (HTTP 202 Accepted is the standard response for an accepted but not yet completed
  asynchronous operation).
- **Cons:** The client must poll for completion; a sync failure is not surfaced in the
  response to `POST /api/sync` — it is observable only via `GET /api/sync/status` or
  application logs.

### Option C — WebSocket or Server-Sent Events for progress streaming

- Push sync progress events to the client in real time.
- **Pros:** Rich UX; client knows when sync finishes.
- **Cons:** Significant complexity (NestJS gateway, client EventSource); CloudFront
  does not support WebSocket upgrades by default; overkill for an internal tool. Ruled out.

---

## Decision

> `POST /api/sync` returns HTTP 202 immediately and runs `syncService.syncAll()` in the
> background without awaiting. A `.catch()` handler logs unexpected top-level rejections.
> Clients poll `GET /api/sync/status` to observe sync progress and the last-synced
> timestamp per board.

---

## Rationale

HTTP 202 Accepted is the semantically correct status code for "the request has been
accepted for processing, but the processing has not been completed". The fire-and-forget
pattern is the simplest way to decouple HTTP response lifetime from sync duration, and
is appropriate for an internal tool where the operator can check sync status separately.
The alternative (keeping a long-lived HTTP connection open) is fragile and incompatible
with the CloudFront timeout.

---

## Consequences

### Positive

- The sync endpoint always returns quickly (< 1 second) regardless of board count or
  Jira API latency.
- The CloudFront 60-second timeout is no longer a risk for any endpoint.
- Sync failures are logged and reflected in `SyncLog` per board; the UI can surface
  the last-synced timestamp and any error status.

### Negative / Trade-offs

- A client that calls `POST /api/sync` and immediately calls a metric endpoint may
  receive stale data if it does not wait for sync completion. The client should poll
  `GET /api/sync/status` before treating the sync as complete.
- If the Node.js process restarts during a sync, the in-progress sync is abandoned
  silently. The scheduled cron sync (every 30 minutes) will recover on the next run.

### Risks

- The unhandled-rejection handler at the top level of `triggerSync()` logs errors to
  `console.error`. If the logging infrastructure is unavailable (e.g. CloudWatch agent
  not configured), these errors are lost. Ensure App Runner stdout is forwarded to
  CloudWatch Logs.

---

## Related Decisions

- [ADR-0033](0033-cloudfront-as-public-entry-point.md) — CloudFront timeout is the
  proximate cause of this change
- [ADR-0032](0032-nodejs-heap-cap-and-apprunner-instance-sizing.md) — Memory management
  context; sequential sprint-report generation after sync is part of the same commit
