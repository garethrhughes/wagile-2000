# 0029 — MIT License

**Date:** 2026-04-15
**Status:** Accepted
**Deciders:** Architect Agent

## Context

The project needed a software license for distribution and open-source publication. The
choice of license determines how operators, contributors, and organisations can use, modify,
and redistribute the tool. Two realistic candidates were evaluated: MIT and AGPL-3.0. The
tool is a self-hosted internal engineering dashboard intended for adoption by software teams.

All current runtime dependencies (NestJS, TypeORM, React, Next.js, Tailwind CSS, Zod, and
their transitive dependencies) are MIT-licensed. No runtime dependency carries a copyleft
or share-alike constraint.

---

## Options Considered

### Option A — MIT License (selected)

- **Summary:** The most permissive widely-adopted license. Anyone may use, copy, modify,
  merge, publish, distribute, sublicense, and sell copies of the software, provided the
  copyright notice is retained.
- **Pros:**
  - Maximises adoption: organisations can deploy and modify the tool without any obligation
    to publish modifications.
  - Compatible with all current runtime dependencies (all MIT).
  - No legal review required for deployment inside an organisation.
  - Self-hosted tools benefit most from permissive licensing — the value is in deployment,
    not in the license mechanism.
- **Cons:**
  - Offers no protection against a third party redistributing a modified version as a
    competing product without contributing changes back.

### Option B — GNU Affero General Public License v3 (AGPL-3.0)

- **Summary:** A strong copyleft license. Any modified version offered over a network
  (including SaaS) must be published under AGPL-3.0. Intended to close the "application
  service provider" loophole in GPL.
- **Pros:**
  - Requires operators who distribute a modified version as a network service to publish
    their modifications, ensuring improvements flow back to the project.
- **Cons:**
  - **Self-hosted operators are legally required to publish their modifications**, even for
    internal deployments. This creates friction for the primary use case: a team that
    customises `boards.yaml` or makes minor patches for their Jira instance must either
    publish those changes or refrain from modifying the source. This is a material deterrent
    to adoption and is hostile to the tool's purpose.
  - Some organisations have blanket policies prohibiting AGPL software in their internal
    toolchain due to legal uncertainty around the network-use trigger.
  - The tool has no SaaS distribution model; AGPL's primary protection (the network-use
    clause) does not apply to the principal use case. Ruled out.

### Option C — Apache License 2.0

- **Summary:** Permissive license with explicit patent grant.
- **Pros:** Includes an express patent licence, which provides additional protection in
  patent-heavy jurisdictions.
- **Cons:** More complex than MIT with no meaningful additional benefit for this project.
  None of the functionality involves patent-sensitive areas. MIT is simpler and equally
  suitable. Ruled out.

---

## Decision

> The project is licensed under the MIT License (`LICENSE` file at repository root).
> Copyright is held by Gareth Hughes. The MIT License applies to all source code in the
> repository.

---

## Rationale

The tool is a self-hosted engineering dashboard. Its value is derived from deployment and
use, not from license leverage. MIT maximises the number of teams that can adopt, deploy,
and extend it without legal friction. AGPL would actively deter the primary use case
(internal self-hosting with local modifications) by requiring publication of those
modifications. All runtime dependencies are MIT-licensed, so MIT imposes no downstream
incompatibility.

---

## Consequences

### Positive

- Organisations can deploy and modify the tool without any obligation to publish changes,
  removing a common barrier to adoption of self-hosted engineering tools.
- MIT is recognised and pre-approved in most corporate open-source policies; no legal
  review is required before deployment.
- Compatible with all current runtime dependencies; no licence audit is required for the
  existing dependency tree.

### Negative / Trade-offs

- Modifications made by adopting organisations do not flow back to the project by default.
  Contributions are voluntary.
- No patent grant (unlike Apache 2.0). Accepted given the nature of the functionality.

### Risks

- If the project introduces a runtime dependency with a non-MIT license (e.g. GPL, LGPL,
  AGPL), the MIT license of this project does not automatically inherit compatibility. Each
  new dependency must be reviewed for license compatibility before merging.

---

## Related Decisions

None. This is a standalone project-level policy decision.
