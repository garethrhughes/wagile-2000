# 0002 — Cache Jira Data in Postgres Rather Than Querying Live

**Date:** 2026-04-10
**Status:** Accepted
**Deciders:** Project setup team
**Proposal:** N/A

## Context

Jira Cloud enforces API rate limits (typically 10 requests/second per token). The
dashboard aggregates data across many issues, sprints, and boards simultaneously.
A single dashboard page load could require dozens to hundreds of Jira API calls,
making live-query approaches too slow for interactive use and too fragile under
concurrent users. Additionally, changelog reconstruction for sprint membership
(see ADR-0006) is computationally expensive and impractical to perform on every
request.

## Options Considered

### Option A — Sync to Postgres; metrics query local DB
- **Summary:** Run a background cron job to pull Jira data into Postgres; all metric
  calculations read from Postgres
- **Pros:**
  - Dashboard response times are fast (local DB query, not Jira round-trip)
  - No risk of rate-limit errors during page loads
  - Changelog reconstruction and sprint membership snapshots can be computed once at
    sync time and stored
  - Enables complex SQL aggregations not possible via the Jira API
- **Cons:**
  - Data is up to 24 hours stale
  - Requires maintaining a sync pipeline and handling Jira API pagination/errors
  - Adds Postgres as a required infrastructure dependency

### Option B — Query Jira live on every dashboard request
- **Summary:** Issue Jira API calls at request time, cache responses briefly in memory
- **Pros:**
  - Always shows current Jira state
  - No sync infrastructure to maintain
- **Cons:**
  - Hits rate limits under concurrent use
  - Page loads are slow (multiple sequential Jira API round-trips)
  - Changelog reconstruction per request is too expensive
  - In-memory cache is lost on restart and doesn't survive horizontal scaling

### Option C — Query Jira live with Redis caching
- **Summary:** Cache Jira API responses in Redis with a TTL
- **Pros:**
  - Faster than fully live; survives restarts
- **Cons:**
  - Still subject to rate limits during cache misses (e.g. cold start, large boards)
  - Cache invalidation complexity
  - Adds Redis as an additional infrastructure dependency alongside Postgres
  - Changelog reconstruction is still expensive at cache-miss time

## Decision

> We will sync Jira data into a local Postgres database on a daily cron schedule (once
> per day at midnight); all metric calculations will query Postgres directly, never Jira.

## Rationale

The rate-limit and latency constraints rule out live querying for a multi-board
aggregation dashboard. Postgres was already required as the application database, so
using it for the sync cache adds no new infrastructure. The daily staleness window
is acceptable for DORA metrics, which are trend indicators rather than real-time
operational data. Redis (Option C) would add infrastructure complexity without
meaningfully solving the changelog reconstruction cost.

## Consequences

- **Positive:** Fast, predictable dashboard load times; rate-limit safety; enables
  complex SQL-based metric aggregations; changelog snapshots computed once
- **Negative / trade-offs:** Metrics lag real Jira state by up to 24 hours; sync
  failures can leave data stale until the next successful run
- **Risks:** Jira API schema changes or pagination behaviour changes could silently
  break the sync; monitoring and alerting on sync job health is required

## Related Decisions

- [ADR-0001](0001-use-jira-fix-versions-as-deployment-signal.md) — Deployment signals
  are derived from cached fix version and changelog data
- [ADR-0006](0006-sprint-membership-reconstructed-from-changelog.md) — Changelog
  reconstruction is done at sync time and stored, not at query time
