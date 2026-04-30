# 0039 — Migrate from AWS App Runner to ECS Fargate

**Date:** 2026-04-25
**Status:** Accepted
**Author:** Architect Agent
**Related ADRs:** [ADR-0043](../decisions/0043-ecs-fargate-replaces-app-runner.md)

## Problem Statement

AWS App Runner has been deprecated. The Fragile dashboard currently runs both its NestJS
backend and Next.js frontend on App Runner (`infra/terraform/modules/apprunner/main.tf`),
connected to RDS via a VPC connector and fronted by CloudFront distributions with WAF IP
allowlisting. A migration to a supported compute platform is required before App Runner
reaches end-of-life and stops receiving security patches and operational support.

ECS Fargate is the natural successor: it provides full access to ECS primitives (task
definitions, service auto-scaling, security groups, ALB integration) while remaining
fully managed — no EC2 instances to patch or scale. See **Implementation Notes** below
for how the final implementation differs from the ECS Express mode originally proposed.

## Current State

### Architecture Overview

```
Internet
  |
CloudFront (us-east-1 ACM + WAF IP allowlist)
  |--- api.{domain}    --> App Runner backend  (1 vCPU / 2 GB, VPC connector)
  |--- dashboard.{domain} --> App Runner frontend (0.5 vCPU / 1 GB, no VPC)
  |
VPC 10.0.0.0/16
  |-- public-a   (NAT Gateway)
  |-- private-a  (RDS, Lambda, VPC connector ENIs)
  |-- private-b  (RDS, Lambda, VPC connector ENIs)
  |
RDS PostgreSQL 16 (db.t4g.micro, 20 GB gp3)
Lambda (DORA snapshot computation, VPC-attached)
```

### Terraform Modules (all under `infra/terraform/`)

| Module | Purpose |
|---|---|
| `modules/apprunner/` | Two `aws_apprunner_service` resources + shared auto-scaling config |
| `modules/network/` | VPC, subnets, NAT GW, SGs, `aws_apprunner_vpc_connector` |
| `modules/iam/` | App Runner build role, backend/frontend task roles, CI user |
| `modules/ecr/` | Two ECR repositories with lifecycle policies |
| `modules/rds/` | Single-AZ RDS PostgreSQL 16 |
| `modules/secrets/` | Secrets Manager (DB password, Jira token) + SSM parameters |
| `modules/cdn/` | CloudFront distributions + ACM certificates (us-east-1) |
| `modules/dns/` | Route 53 ALIAS records |
| `modules/waf/` | WAFv2 IP allowlist (CLOUDFRONT scope, us-east-1) |
| `modules/lambda/` | DORA snapshot Lambda + SG + RDS ingress rule |
| `environments/prod/` | Root module wiring all of the above |

### Key App Runner Characteristics

- **Backend:** 1024 CPU / 2048 MB, port 3001, VPC egress via VPC connector, health check
  on `/health`, secrets injected via `runtime_environment_secrets` (Secrets Manager ARNs
  and SSM parameter ARNs)
- **Frontend:** 512 CPU / 1024 MB, port 3000, no VPC connector (DEFAULT egress), health
  check on `/api/health`, `HOSTNAME=0.0.0.0` override for standalone Next.js
- **Auto-scaling:** Shared config, min 1 / max 3 instances
- **Deployments:** Manual (`auto_deployments_enabled = false`), triggered by CI via
  `apprunner:StartDeployment` / `apprunner:UpdateService`
- **IAM:** `build.apprunner.amazonaws.com` trust for ECR pull; `tasks.apprunner.amazonaws.com`
  trust for instance roles

### Dockerfiles

- `backend/Dockerfile` -- multi-stage Node 22 Alpine, exposes 3001, heap cap 1800 MB
- `frontend/Dockerfile` -- multi-stage Node 22 Alpine, Next.js standalone output, exposes
  3000, `NEXT_PUBLIC_API_URL` baked at build time via `--build-arg`

## Proposed Solution

Replace the `modules/apprunner/` module with a new `modules/ecs/` module that uses ECS
Express mode via the `terraform-aws-modules/terraform-aws-ecs` community module's
`express-service` sub-module. This uses the `aws_ecs_express_gateway_service` resource
type -- not standard `aws_ecs_service`. The Express module manages the ALB, target groups,
and listener rules internally; there are no task definitions to register and no ALB
infrastructure to configure manually. All other modules (ECR, RDS, secrets, CDN, DNS, WAF,
Lambda) remain unchanged or require only minor output/variable rewiring.

### Target Architecture

```
Internet
  |
CloudFront (unchanged -- us-east-1 ACM + WAF IP allowlist)
  |--- api.{domain}    --> ECS Express backend service (ALB managed by Express)
  |--- dashboard.{domain} --> ECS Express frontend service (ALB managed by Express)
  |
VPC 10.0.0.0/16 (unchanged)
  |-- public-a   (NAT Gateway -- unchanged)
  |-- private-a  (RDS, Lambda, ECS tasks)
  |-- private-b  (RDS, Lambda, ECS tasks)
  |
ECS Cluster "fragile" (Express mode)
  |-- Service: fragile-backend  (1024 CPU / 2048 MB, port 3001)
  |-- Service: fragile-frontend (512 CPU / 1024 MB, port 3000)
  |
RDS PostgreSQL 16 (unchanged)
Lambda (unchanged)
```

### Module Changes

#### 1. New `modules/ecs/main.tf`

Uses the `terraform-aws-modules/terraform-aws-ecs` module (version `~> 6.0`) with its
`express-service` sub-module. This creates `aws_ecs_express_gateway_service` resources --
the module handles ALB provisioning, target group registration, and listener rules
internally. Two service definitions:

**Backend service:**
```hcl
module "backend_service" {
  source = "terraform-aws-modules/ecs/aws//modules/express-service"

  name    = "fragile-backend"
  cluster = module.ecs_cluster.cluster_name

  cpu    = "1024"
  memory = "2048"

  primary_container = {
    image = var.backend_image_uri
    port  = 3001

    environment = {
      NODE_ENV     = "production"
      PORT         = "3001"
      DB_PORT      = "5432"
      DB_DATABASE  = "fragile"
      DB_USERNAME  = "postgres"
      DB_HOST      = var.rds_endpoint
      FRONTEND_URL = var.frontend_url
      DORA_SNAPSHOT_LAMBDA_NAME = var.dora_snapshot_lambda_name
      AWS_REGION   = var.aws_region
      USE_LAMBDA   = "true"
    }

    secrets = {
      DB_PASSWORD     = var.db_password_secret_arn
      JIRA_API_TOKEN  = var.jira_api_token_secret_arn
      JIRA_BASE_URL   = var.jira_base_url_param_arn
      JIRA_USER_EMAIL = var.jira_user_email_param_arn
      TIMEZONE        = var.timezone_param_arn
    }
  }

  health_check_path = "/health"

  network_configuration = {
    subnets         = var.private_subnet_ids
    security_groups = [aws_security_group.backend.id]
  }

  # NOTE: Exact parameter names (min_capacity, max_capacity, metric, threshold)
  # should be verified against the express-service module's variables.tf during
  # implementation, as names may differ from what is shown here.
  scaling_target = {
    min_capacity = 1
    max_capacity = 3
    metric       = "cpu"
    threshold    = 80
  }

  # Infrastructure role for Express Gateway (manages ALB, networking)
  infrastructure_role_arn = aws_iam_role.ecs_infrastructure.arn

  # Task role permissions for Secrets Manager, SSM, Lambda invoke, CloudWatch
  task_role_statements = { ... }

  # Execution role needs ECR pull + secrets read
  execution_role_statements = { ... }
}
```

**Frontend service:**
```hcl
module "frontend_service" {
  source = "terraform-aws-modules/ecs/aws//modules/express-service"

  name    = "fragile-frontend"
  cluster = module.ecs_cluster.cluster_name

  cpu    = "512"
  memory = "1024"

  primary_container = {
    image = var.frontend_image_uri
    port  = 3000

    environment = {
      NODE_ENV = "production"
      HOSTNAME = "0.0.0.0"
    }
  }

  health_check_path = "/api/health"

  network_configuration = {
    subnets         = var.private_subnet_ids
    security_groups = [aws_security_group.frontend.id]
  }

  # NOTE: Verify parameter names against the module's variables.tf during implementation.
  scaling_target = {
    min_capacity = 1
    max_capacity = 3
    metric       = "cpu"
    threshold    = 80
  }

  # Infrastructure role for Express Gateway
  infrastructure_role_arn = aws_iam_role.ecs_infrastructure.arn
}
```

**ECS Cluster:**
```hcl
module "ecs_cluster" {
  source  = "terraform-aws-modules/ecs/aws//modules/cluster"
  version = "~> 6.0"

  cluster_name = "fragile"

  fargate_capacity_providers = {
    FARGATE = {
      default_capacity_provider_strategy = {
        weight = 1
      }
    }
  }
}
```

#### 2. Modify `modules/network/main.tf`

- **Remove:** `aws_apprunner_vpc_connector` resource (no longer needed; ECS tasks run
  directly in the VPC subnets)
- **Rename/repurpose:** `aws_security_group.apprunner_connector` becomes
  `aws_security_group.ecs_backend` with the same egress rules
- **Add:** A public subnet in AZ b (`10.0.3.0/24`) for ALB placement (ALBs require subnets
  in at least two AZs). The Express module places the ALB in public subnets automatically;
  all ECS tasks run in private subnets only.
- **Add:** Security group for frontend ECS tasks (egress-only, no VPC dependencies)
- **Update:** RDS ingress rule to reference the new backend SG name
- **Remove output:** `vpc_connector_arn` (no longer exists)
- **Note:** No `public_subnet_ids` output is needed for task placement -- both backend and
  frontend tasks run in private subnets. The Express module manages ALB placement in public
  subnets internally.

#### 3. Modify `modules/iam/main.tf`

ECS Express requires three IAM roles:

- **Execution role:** Trusts `ecs-tasks.amazonaws.com`. Permissions: ECR image pull,
  CloudWatch Logs write, Secrets Manager and SSM Parameter Store read. This replaces the
  App Runner build role.
- **Task role:** Trusts `ecs-tasks.amazonaws.com`. Permissions: application-level access
  (RDS connectivity via SGs, Lambda invoke, CloudWatch metrics). This replaces the App
  Runner instance role -- update the trust policy from `tasks.apprunner.amazonaws.com` to
  `ecs-tasks.amazonaws.com`.
- **Infrastructure role** (new): Trusts `ecs.amazonaws.com`. This role is used by the ECS
  Express Gateway to manage ALB, target groups, listener rules, and other infrastructure
  on behalf of the service. Requires the `AmazonECSInfrastructureRoleforExpressGatewayServices`
  AWS managed policy. This role has no App Runner equivalent.

Additional IAM changes:

- **Remove:** `apprunner_build_trust` policy document and `apprunner_build` role
- **Update CI permissions:** Replace App Runner permissions with Express Gateway permissions
  (see CI/CD section below)
- **Update CloudWatch log group patterns:** Change `/aws/apprunner/fragile-*` to
  `/aws/ecs/fragile-*` or whatever log group name the Express module creates

#### 4. Modify `modules/cdn/main.tf`

- **Update origin domain names:** CloudFront origins currently point at App Runner service
  URLs (`*.awsapprunner.com`). These change to the ECS Express service URLs, which follow
  the pattern `https://{service-name}.ecs.{region}.on.aws/`. For example:
  - Backend: `fragile-backend.ecs.ap-southeast-2.on.aws`
  - Frontend: `fragile-frontend.ecs.ap-southeast-2.on.aws`
- **Update origin protocol:** The Express service URLs provide HTTPS. Origin protocol
  policy should be `https-only` pointing at the Express-provided domain.
- **The `AllViewerExceptHostHeader` origin request policy remains correct** -- it prevents
  sending the custom domain as Host to the origin, which would confuse the ALB just as
  it confused App Runner.

#### 5. Modify `environments/prod/main.tf`

- Replace `module "apprunner"` with `module "ecs"`
- Remove `vpc_connector_arn` from the wiring
- Add `private_subnet_ids` to the ECS module inputs
- Update outputs to reference ECS service URLs instead of App Runner service URLs

### Secrets and Environment Variables

ECS Express handles secrets via the standard ECS secrets mechanism:

- **Secrets Manager ARNs** and **SSM Parameter ARNs** are passed as `secrets` in the
  container definition. ECS injects them as environment variables at task startup --
  identical behaviour to App Runner's `runtime_environment_secrets`.
- **Plain environment variables** are passed as `environment` in the container definition --
  identical to App Runner's `runtime_environment_variables`.
- **No changes needed** to the `modules/secrets/` module or to any secret/parameter values.

### Networking Detail

ECS Express mode provisions and manages an ALB automatically as a single shared instance.
When both services share the same network configuration, Express consolidates them behind
one ALB with separate listener rules -- this is automatic and requires no explicit
configuration. Key considerations:

1. **Backend tasks** run in private subnets (same as today via VPC connector). They reach
   RDS directly and reach the internet (Jira API) via NAT Gateway.
2. **Frontend tasks** also run in private subnets behind the Express-managed ALB. The ALB
   lives in public subnets and handles public ingress.
3. **Single shared ALB:** Express manages one ALB for both services, with host/path-based
   routing rules. This is a single $22/mo charge, not per-service. Up to 25 services can
   share the same ALB.
4. **Security groups:** Backend SG allows inbound from ALB SG on port 3001; frontend SG
   allows inbound from ALB SG on port 3000. Backend SG allows outbound to RDS SG on 5432
   and to 0.0.0.0/0 (NAT for Jira). Frontend SG allows outbound to 0.0.0.0/0 only
   (no VPC dependencies).

### Auto-Scaling

ECS Express supports auto-scaling natively via the `scaling_target` block:

- **Metric:** Average CPU utilisation (same as current App Runner config)
- **Target:** 80% CPU
- **Min/Max:** 1/3 tasks per service (matching current App Runner min 1 / max 3)
- Scale-in cooldown and scale-out cooldown are configurable if needed

### Health Checks

- Backend: `/health` on port 3001 (unchanged)
- Frontend: `/api/health` on port 3000 (unchanged)
- The Express-managed ALB performs the health checks instead of App Runner's internal
  health checker. Interval and threshold settings are configurable.

## Migration Plan

Brief downtime is acceptable for this migration. Rather than running App Runner and ECS
Express in parallel, this is a single-pass cutover: tear down App Runner, deploy ECS
Express, and update CloudFront origins, all in one `terraform apply`.

### Phase 0: Preparation (no production impact)

1. Create the `modules/ecs/` module alongside the existing `modules/apprunner/` module
2. Add a second public subnet (`public-b`) to `modules/network/` for ALB placement
   (ALBs require subnets in at least two AZs)
3. Create the ECS infrastructure IAM role with the
   `AmazonECSInfrastructureRoleforExpressGatewayServices` managed policy
4. Update `versions.tf` to pin the `terraform-aws-modules/ecs` module version
5. Write and test the ECS module in isolation using `terraform plan` with a separate
   environment workspace or a `staging` environment
6. Update the CI/CD deployment scripts and IAM permissions for the `fragile-ci` user

### Phase 1: Cutover (single `terraform apply`)

1. Update `environments/prod/main.tf`:
   - Replace `module "apprunner"` with `module "ecs"`
   - Remove `aws_apprunner_vpc_connector` from `modules/network/`
   - Remove the App Runner build role from `modules/iam/`
   - Update `modules/cdn/` origins to point at `*.ecs.{region}.on.aws` service URLs
   - Update RDS SG ingress rule to reference the new ECS backend SG
2. Run `terraform plan` to review all changes -- confirm App Runner resources are destroyed
   and ECS Express resources are created
3. Run `terraform apply` to execute the cutover
4. Verify ECS Express services are healthy by hitting their health check endpoints
5. Verify CloudFront is routing traffic to ECS Express
6. Run a full Jira sync cycle and confirm DORA snapshot Lambda invocation works
7. Confirm CI can deploy new images to ECS Express

### Estimated Downtime

Brief downtime is expected during the cutover. The duration depends on:

- Terraform destroying App Runner resources and creating ECS Express resources (~3-5 min)
- ECS tasks reaching a healthy state and passing ALB health checks (~1-2 min)
- CloudFront propagating the origin change (~1-5 min)

**Total estimated downtime: 5-12 minutes.** This is acceptable for an internal tool with
a small user base. The cutover should be scheduled during off-hours to minimise impact.

**Rollback plan:** If ECS Express fails to come up healthy, redeploy App Runner by
reverting the Terraform changes and running `terraform apply`. This would incur a second
period of downtime but restores the known-good state.

## Database Considerations

- **No changes to RDS.** The database instance, subnet group, parameter group, and
  security group remain unchanged.
- **Security group update:** The RDS SG ingress rule currently references the App Runner
  VPC connector SG (`aws_security_group.apprunner_connector`). This must be updated to
  reference the new ECS backend task SG.
- **Connection pooling:** ECS tasks connect to RDS the same way App Runner instances do --
  directly via the `pg` driver. No connection pooler (PgBouncer) is needed at current
  scale (max 3 backend tasks, each with a small connection pool).
- **Lambda:** The DORA snapshot Lambda has its own SG and RDS ingress rule
  (`modules/lambda/main.tf`). No changes needed.

## CI/CD Changes

### Current Flow

1. CI pushes images to ECR (`ecr:PutImage`)
2. CI calls `apprunner:StartDeployment` to trigger a rolling deployment
3. App Runner pulls the new image and replaces instances

### New Flow

1. CI pushes images to ECR (unchanged)
2. CI triggers a deployment to the ECS Express Gateway service. The Express Gateway
   manages image updates internally -- there are no task definitions to register manually
   and no `ecs:UpdateService` call in the standard ECS sense.
3. Deployment is triggered either via Terraform apply (updating the image URI in the
   Express service configuration) or via the Express Gateway Service API.

**Note:** The exact Express Gateway API actions for CI-triggered deployments should be
confirmed against AWS documentation during implementation. The Express Gateway API is
distinct from the standard ECS API -- actions like `ecs:RegisterTaskDefinition` and
`ecs:UpdateService` do not apply.

### IAM Changes for `fragile-ci` User

Replace App Runner permissions:
```hcl
# Remove
"apprunner:UpdateService",
"apprunner:DescribeService",
"apprunner:ListServices",
"apprunner:StartDeployment",

# Add -- exact action names to be confirmed against AWS documentation
# for the Express Gateway Service API during implementation.
"iam:PassRole",  # needed to pass task/execution/infrastructure roles to ECS
```

The `iam:PassRole` permission must be scoped to the specific task, execution, and
infrastructure role ARNs to follow least-privilege.

## Cost Comparison

### App Runner (current)

| Component | Monthly Cost (ap-southeast-2) |
|---|---|
| Backend: 1 vCPU, 2 GB, always-on | ~$29/mo (provisioned) |
| Frontend: 0.5 vCPU, 1 GB, always-on | ~$15/mo (provisioned) |
| VPC connector (NAT bandwidth) | ~$3-5/mo |
| NAT Gateway | ~$45/mo (fixed) + data |
| **App Runner subtotal** | **~$92-94/mo** |

### ECS Express (proposed)

| Component | Monthly Cost (ap-southeast-2) |
|---|---|
| Backend: Fargate 1 vCPU, 2 GB, always-on | ~$36/mo |
| Frontend: Fargate 0.5 vCPU, 1 GB, always-on | ~$18/mo |
| ALB (single shared instance across both services) | ~$22/mo (fixed) + LCU |
| NAT Gateway | ~$45/mo (fixed) + data |
| **ECS Express subtotal** | **~$121-125/mo** |

### Analysis

ECS Express is approximately **$27-31/mo more expensive** than App Runner, primarily due
to the ALB fixed cost ($22/mo) that App Runner included in its per-instance pricing. The
ALB is a single shared instance managed by Express for both services -- there is no risk
of paying for two separate ALBs. This is an acceptable trade-off given:

1. App Runner is deprecated and will eventually be unsupported
2. ECS Express provides full access to ECS primitives for future needs
3. The ALB enables features App Runner lacked: path-based routing, sticky sessions,
   WebSocket support, and integration with AWS WAF at the ALB level (in addition to
   CloudFront WAF)
4. Fargate Savings Plans (1-year, no upfront) could reduce Fargate compute costs by ~30%,
   bringing the total below the current App Runner cost

**Cost mitigation options:**
- **Fargate Spot** for the frontend service (stateless, tolerant of interruption) --
  saves ~70% on compute
- **Fargate Savings Plans** for the backend service -- saves ~30% on compute
- **ARM64 (Graviton)** -- Fargate ARM pricing is 20% lower; both Dockerfiles use
  `node:22-alpine` which supports multi-arch. Requires rebuilding images for `linux/arm64`.

## Alternatives Considered

### Alternative A -- ECS on Fargate (standard, not Express)

Standard ECS on Fargate requires manually configuring ALBs, target groups, listener rules,
task definitions, and service definitions. It offers maximum control but significantly
more Terraform code and operational surface area. ECS Express abstracts the ALB and
networking setup while still exposing the underlying resources in the account for
customisation. For a two-service internal tool, Express mode's convenience outweighs the
marginal loss of control.

**Ruled out:** Unnecessary complexity for our use case. Express mode provides the same
primitives with less boilerplate.

### Alternative B -- AWS Lambda + API Gateway (serverless)

The NestJS backend runs a daily cron job for Jira sync and holds database connections.
Lambda's 15-minute execution limit and cold-start latency make it unsuitable for the
backend. The DORA snapshot Lambda already demonstrates this constraint -- it is a
purpose-built, short-lived function. The frontend (Next.js standalone) could theoretically
run on Lambda@Edge or via the Serverless Next.js component, but the operational complexity
and cold-start impact are not justified for an always-on internal tool.

**Ruled out:** Architectural mismatch with the backend's long-running cron jobs and
persistent database connections.

### Alternative C -- AWS Lightsail Containers

Lightsail offers simple container hosting at fixed monthly prices. However, it lacks VPC
integration (containers run in Lightsail's managed VPC, not yours), making it impossible
to reach the existing RDS instance in the Fragile VPC without a VPN or peering connection.
It also lacks IAM-based secrets injection, auto-scaling, and integration with the existing
Terraform modules.

**Ruled out:** Cannot reach RDS without networking hacks; poor Terraform support.

### Alternative D -- EC2 instances with Docker Compose

Running both services on a single t4g.small EC2 instance with Docker Compose would be the
cheapest option (~$15/mo). However, it requires manual patching, lacks health-check-based
restarts, has no auto-scaling, and introduces a single point of failure with no rolling
deployments. It also requires managing TLS termination (via Caddy/nginx) on the instance.

**Ruled out:** Operational burden too high for the marginal cost saving.

## Impact Assessment

| Area | Impact | Notes |
|---|---|---|
| Database | None | RDS instance unchanged; only SG ingress rule source changes |
| API contract | None | No endpoint changes; same containers, same ports |
| Frontend | None | Same Docker image, same Next.js standalone server |
| Tests | None | No application code changes; infrastructure-only migration |
| Jira API | None | Backend still reaches Jira via NAT Gateway from private subnet |
| Terraform | Major refactor | New `modules/ecs/`, modified `modules/network/`, `modules/iam/`, `modules/cdn/`, `environments/prod/` |
| CI/CD | Moderate | Deployment trigger changes from App Runner API to Express Gateway API |
| Cost | +$27-31/mo | Mitigable via Fargate Spot/Savings Plans/Graviton |
| Downtime | ~5-12 min | Single-pass cutover during off-hours |

## Open Questions

1. **Graviton (ARM64):** Moving to ARM64 Fargate tasks saves 20% on compute. The Docker
   images use `node:22-alpine` which supports `linux/arm64`. Should this migration be
   bundled with the ECS move or done as a follow-up?

2. **Fargate Spot for frontend:** The frontend is stateless and interruption-tolerant. Is
   there an acceptable risk of brief downtime during Spot reclamation, given CloudFront
   will return 502/503 until a replacement task starts?

3. **Second public subnet:** The current network module has only one public subnet
   (`public-a`). ALBs require subnets in at least two AZs. A `public-b` subnet must be
   added. Confirm this does not conflict with the existing CIDR allocation (`10.0.0.0/24`
   for public-a; `10.0.3.0/24` proposed for public-b).

## Acceptance Criteria

- [ ] New `infra/terraform/modules/ecs/` module exists, using the `terraform-aws-modules/
  terraform-aws-ecs` community module's `express-service` sub-module
  (`aws_ecs_express_gateway_service` resource type)
- [ ] ECS infrastructure IAM role exists with the
  `AmazonECSInfrastructureRoleforExpressGatewayServices` managed policy
- [ ] Both backend and frontend ECS Express services are running and healthy in the Fragile
  VPC private subnets, verified by hitting their health check endpoints
- [ ] Backend ECS task can connect to RDS and execute a Jira sync successfully
- [ ] Backend ECS task can invoke the DORA snapshot Lambda
- [ ] Frontend ECS task serves the dashboard UI with correct `NEXT_PUBLIC_API_URL`
- [ ] CloudFront distributions route traffic to ECS Express service URLs
  (`*.ecs.{region}.on.aws`)
- [ ] WAF IP allowlisting continues to function via CloudFront
- [ ] CI (`fragile-ci` IAM user) can trigger deployments to ECS Express services
- [ ] Auto-scaling is configured (min 1 / max 3) and responds to CPU load
- [ ] `modules/apprunner/` and `aws_apprunner_vpc_connector` are removed from Terraform
  state and code
- [ ] `terraform plan` shows no pending changes after full migration
- [ ] All secrets and SSM parameters are injected correctly into ECS tasks (verified by
  checking backend logs for successful Jira API authentication and DB connection)
- [ ] No application code changes required -- same Docker images work on both platforms
- [ ] Total cutover downtime is under 15 minutes

---

## Implementation Notes (post-acceptance deviations from proposal)

> These notes record how the actual implementation in `infra/terraform/modules/ecs/`
> differs from the design described above. The proposal was written for **ECS Express
> mode** (using the `terraform-aws-modules/ecs` community module's `express-service`
> sub-module). The implementation uses **standard ECS on Fargate** with explicit
> `aws_ecs_task_definition` and `aws_ecs_service` resources. The differences are
> documented here; the ADR records the final decision.

### Compute: standard ECS Fargate, not ECS Express community module

The implementation does not use the `terraform-aws-modules/ecs` community module or the
`aws_ecs_express_gateway_service` resource type. Instead it uses the standard AWS provider
resources directly:

- `aws_ecs_cluster` + `aws_ecs_cluster_capacity_providers` (FARGATE only)
- `aws_ecs_task_definition` for both backend and frontend (with full `container_definitions`
  JSON, secrets injection, health checks, and CloudWatch log configuration inline)
- `aws_ecs_service` for both services, referencing the task definition ARN and attaching to
  an ALB target group

This approach requires more Terraform code than the Express module would have, but avoids a
community module dependency and gives explicit control over every resource.

### Networking: CloudFront VPC Origin replaces direct `*.ecs.on.aws` routing

The proposal assumed CloudFront origins would point at the ECS Express-managed `*.ecs.{region}.on.aws`
service URLs. Because the implementation uses standard ECS services behind an ALB, the ALB
does not have a public DNS endpoint — it is an **internal ALB** (not internet-facing).

CloudFront reaches the ALB via a **CloudFront VPC Origin** (`aws_cloudfront_vpc_origin`),
which allows CloudFront edge nodes to connect to resources inside the VPC without the ALB
needing a public IP. A single VPC Origin covers both distributions; the correct ECS service
is selected by a custom header (`X-Fragile-Service: backend` or `X-Fragile-Service: frontend`)
injected by each CloudFront distribution. The ALB listener rules forward to the appropriate
target group based on this header.

### ALB: external, not auto-provisioned by Express

The proposal stated the ECS Express module would provision and manage the ALB automatically.
In the implementation the ALB is pre-provisioned externally (by the ECS Express Gateway
infrastructure, or manually) and the ECS module looks it up via `data "aws_lb"` filtering on
`AmazonECSManaged=true` and `Project=fragile` tags. Listener rules on the discovered ALB's
port-80 and port-443 listeners route requests to the backend and frontend target groups.

The target group ARNs (`backend_target_group_arn`, `frontend_target_group_arn`) are passed
in as variables to the ECS module from the root environment.

### IAM: ECS infrastructure role retained despite no Express module

The ECS infrastructure role (`fragile-ecs-infrastructure-role`) with the
`AmazonECSInfrastructureRoleforExpressGatewayServices` managed policy was kept because the
ALB that services the ECS tasks was provisioned by the ECS Express Gateway infrastructure.
This role remains necessary for that Gateway to manage ALB resources on behalf of the services.

### CI/CD deployment: standard ECS service update

The CI user (`fragile-ci`) deploys new images by:

1. Pushing a new image to ECR (unchanged)
2. Registering a new task definition revision (implicitly, via `ecs:UpdateService` or
   `ecs:RegisterTaskDefinition`)
3. Calling `ecs:UpdateService` to point the service at the new task definition

CI permissions include `ecs:DescribeServices`, `ecs:UpdateService`, `ecs:DescribeClusters`,
`ecs:ListServices`, and `iam:PassRole` scoped to the four ECS IAM roles.

### Auto-scaling: not yet configured in initial implementation

The initial ECS module does not include Application Auto Scaling (`aws_appautoscaling_*`)
resources. Services start with `desired_count = 1` and `lifecycle { ignore_changes = [desired_count] }`.
Auto-scaling can be added as a follow-up without other changes.

### Cost: ALB is internal, reducing fixed ALB cost

The ALB in the implementation is managed by the ECS Express Gateway infrastructure. The
proposal's cost table assumed a dedicated ALB at ~$22/mo; actual cost depends on whether the
ECS Express Gateway ALB is shared with other consumers or dedicated to Fragile. Monitor actual
ALB costs in the AWS Cost Explorer.

### Network SG ingress rules: in root module to break dependency cycle

The ingress rules that allow the ALB security group to reach the ECS task security groups
(ports 3001 and 3000) are defined as `aws_security_group_rule` resources in
`environments/prod/main.tf` rather than inside `modules/network/` or `modules/ecs/`. This
avoids a circular dependency:
`modules/network` SGs → `modules/ecs` services → ALB data source → ALB SG ID → `modules/network` SGs.

### RDS security group description: stale comment

`modules/network/main.tf` contains a stale comment on the `fragile-rds-sg` resource:
`"Allow inbound PostgreSQL from the App Runner VPC connector only."` This description is
cosmetically wrong (the VPC connector no longer exists) but does not affect behaviour.
It should be updated in a follow-up cleanup.
