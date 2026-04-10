# Decision Log

This directory contains Architecture Decision Records (ADRs) for the wagile-2000
DORA & Planning Metrics Dashboard project. Each file documents a significant
technical or architectural decision, the options that were considered, and the
rationale for the choice made.

ADRs are append-only. Superseded decisions are marked `Superseded by [NNNN]` and
a new ADR is created for the replacement decision.

## Index

| # | Title | Status | Date |
|---|---|---|---|
| [0001](0001-use-jira-fix-versions-as-deployment-signal.md) | Use Jira fix versions as primary deployment signal with done-status fallback | Accepted | 2026-04-10 |
| [0002](0002-cache-jira-data-in-postgres.md) | Cache Jira data in Postgres rather than querying live per request | Accepted | 2026-04-10 |
| [0003](0003-per-board-configurable-rules-for-cfr-and-mttr.md) | Per-board configurable rules for CFR and MTTR stored in BoardConfig entity | Accepted | 2026-04-10 |
| [0004](0004-single-user-api-key-auth.md) | Single-user API key auth via Passport HeaderAPIKeyStrategy | Accepted | 2026-04-10 |
| [0005](0005-kanban-boards-excluded-from-planning-accuracy.md) | Kanban boards excluded from planning accuracy report | Accepted | 2026-04-10 |
| [0006](0006-sprint-membership-reconstructed-from-changelog.md) | Sprint membership at start date reconstructed from Jira changelog | Accepted | 2026-04-10 |
| [0007](0007-monorepo-backend-frontend-directories.md) | Monorepo with backend/ and frontend/ directories (not apps/api + apps/web) | Accepted | 2026-04-10 |
| [0008](0008-tailwind-css-v4-css-first-configuration.md) | Tailwind CSS v4 with CSS-first configuration (no tailwind.config.js) | Accepted | 2026-04-10 |
| [0009](0009-roadmap-accuracy-jpd-sync-strategy.md) | Roadmap Accuracy: JPD sync and metric calculation strategy | Accepted | 2026-04-10 |
| [0010](0010-kanban-roadmap-accuracy-via-changelog-board-entry-date.md) | Kanban roadmap accuracy via changelog board-entry date and quarter bucketing | Accepted | 2026-04-10 |
| [0011](0011-delivery-link-filtering-scoped-to-epic-issue-type.md) | Delivery link filtering scoped to Epic issue type only | Accepted | 2026-04-10 |
| [0012](0012-roadmap-accuracy-query-correctness-scoped-ideas-and-n-plus-one-fix.md) | Roadmap accuracy query correctness: scoped idea loading and N+1 elimination | Accepted | 2026-04-10 |
| [0013](0013-board-id-required-on-accuracy-endpoint.md) | `boardId` made required on the roadmap accuracy endpoint | Accepted | 2026-04-10 |
| [0014](0014-sprint-detail-view.md) | Sprint Detail View: new SprintModule with per-issue annotation endpoint | Accepted | 2026-04-10 |
| [0015](0015-board-config-as-metric-filter-composition-point.md) | BoardConfig as the sole composition point for metric filter rules | Proposed | 2026-04-10 |
| [0016](0016-quarter-detail-view.md) | Calendar-period drill-down as a first-class view pattern | Proposed | 2026-04-10 |
