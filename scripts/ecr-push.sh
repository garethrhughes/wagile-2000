#!/usr/bin/env bash
# ecr-push.sh — Build and push backend + frontend images to ECR.
#
# Usage:
#   ./scripts/ecr-push.sh [OPTIONS]
#
# Options:
#   -t, --tag TAG       Image tag (default: short git SHA)
#   -r, --region REGION AWS region (default: ap-southeast-2)
#   --backend-only      Build and push only the backend image
#   --frontend-only     Build and push only the frontend image
#   -h, --help          Show this help
#
# Prerequisites:
#   - AWS credentials for your AWS account (env vars or profile)
#   - Docker running
#   - terraform output available (or set ECR_BACKEND_URL / ECR_FRONTEND_URL manually)
#
# The ECR repo URLs are read from Terraform outputs. Run from the repo root.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TF_DIR="$REPO_ROOT/infra/terraform/environments/prod"

# ── Defaults ─────────────────────────────────────────────────────────────────
AWS_REGION="${AWS_REGION:-ap-southeast-2}"
IMAGE_TAG="${IMAGE_TAG:-$(git -C "$REPO_ROOT" rev-parse --short HEAD)}"
BUILD_BACKEND=true
BUILD_FRONTEND=true

# ── Argument parsing ──────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case $1 in
    -t|--tag)       IMAGE_TAG="$2";    shift 2 ;;
    -r|--region)    AWS_REGION="$2";  shift 2 ;;
    --backend-only) BUILD_FRONTEND=false; shift ;;
    --frontend-only) BUILD_BACKEND=false; shift ;;
    -h|--help)
      sed -n '/^# Usage/,/^[^#]/p' "$0" | grep '^#' | sed 's/^# \?//'
      exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

echo "==> Image tag : $IMAGE_TAG"
echo "==> Region    : $AWS_REGION"

# ── Resolve ECR URLs from Terraform outputs (or env override) ─────────────────
resolve_ecr_urls() {
  if [[ -n "${ECR_BACKEND_URL:-}" && -n "${ECR_FRONTEND_URL:-}" ]]; then
    echo "    Using ECR URLs from environment variables."
    return
  fi

  echo "==> Reading ECR URLs from Terraform outputs..."
  if ! command -v terraform &>/dev/null; then
    echo "ERROR: terraform not found. Set ECR_BACKEND_URL and ECR_FRONTEND_URL manually." >&2
    exit 1
  fi

  pushd "$TF_DIR" >/dev/null
  ECR_BACKEND_URL="$(terraform output -raw backend_ecr_repository_url 2>/dev/null)"
  ECR_FRONTEND_URL="$(terraform output -raw frontend_ecr_repository_url 2>/dev/null)"
  popd >/dev/null

  if [[ -z "$ECR_BACKEND_URL" || -z "$ECR_FRONTEND_URL" ]]; then
    echo "ERROR: Could not read ECR URLs from Terraform. Have you run terraform apply?" >&2
    echo "       Alternatively, set ECR_BACKEND_URL and ECR_FRONTEND_URL env vars." >&2
    exit 1
  fi
}

# NEXT_PUBLIC_API_URL is baked into the Next.js JS bundle at docker build time —
# it cannot be injected at runtime via App Runner environment variables.
# Read it from the Terraform backend_custom_domain output so the correct URL is
# always used, with an env override for exceptional cases.
resolve_api_url() {
  if [[ -n "${NEXT_PUBLIC_API_URL:-}" ]]; then
    echo "    Using NEXT_PUBLIC_API_URL from environment: $NEXT_PUBLIC_API_URL"
    return
  fi

  echo "==> Reading backend custom domain URL from Terraform outputs..."
  if ! command -v terraform &>/dev/null; then
    echo "ERROR: terraform not found. Set NEXT_PUBLIC_API_URL manually." >&2
    exit 1
  fi

  pushd "$TF_DIR" >/dev/null
  NEXT_PUBLIC_API_URL="$(terraform output -raw backend_custom_domain 2>/dev/null)"
  popd >/dev/null

  if [[ -z "$NEXT_PUBLIC_API_URL" ]]; then
    echo "ERROR: Could not read backend_custom_domain from Terraform. Have you run terraform apply?" >&2
    echo "       Alternatively, set NEXT_PUBLIC_API_URL env var." >&2
    exit 1
  fi
}

resolve_ecr_urls
resolve_api_url
echo "==> Backend ECR  : $ECR_BACKEND_URL"
echo "==> Frontend ECR : $ECR_FRONTEND_URL"
echo "==> API URL      : $NEXT_PUBLIC_API_URL"

# ── ECR login ─────────────────────────────────────────────────────────────────
AWS_ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
echo "==> Logging in to ECR (account $AWS_ACCOUNT_ID, region $AWS_REGION)..."
aws ecr get-login-password --region "$AWS_REGION" \
  | docker login --username AWS --password-stdin \
      "$AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com"

# ── Helper: build, tag, push ──────────────────────────────────────────────────
build_and_push() {
  local name="$1"       # "backend" or "frontend"
  local context="$2"    # build context path
  local repo_url="$3"   # ECR repo URL (no tag)
  shift 3
  local extra_args=("$@")  # any extra --build-arg etc.

  local full_tag="$repo_url:$IMAGE_TAG"
  local latest_tag="$repo_url:latest"

  echo
  echo "==> Building $name image..."
  docker build \
    --platform linux/amd64 \
    -t "$full_tag" \
    -t "$latest_tag" \
    ${extra_args[@]+"${extra_args[@]}"} \
    "$context"

  echo "==> Pushing $name:$IMAGE_TAG..."
  docker push "$full_tag"

  echo "==> Pushing $name:latest..."
  docker push "$latest_tag"

  echo "    $name pushed: $full_tag"
}

# ── Build & push ──────────────────────────────────────────────────────────────
if [[ "$BUILD_BACKEND" == "true" ]]; then
  build_and_push \
    "backend" \
    "$REPO_ROOT/backend" \
    "$ECR_BACKEND_URL"
fi

if [[ "$BUILD_FRONTEND" == "true" ]]; then
  # NEXT_PUBLIC_API_URL is resolved from Terraform outputs by resolve_api_url()
  # above (or from the env override). It is baked into the JS bundle at build
  # time via --build-arg — the App Runner runtime env var has no effect for
  # Next.js NEXT_PUBLIC_ variables.
  build_and_push \
    "frontend" \
    "$REPO_ROOT/frontend" \
    "$ECR_FRONTEND_URL" \
    --build-arg "NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL"
fi

echo
echo "==> Done. Trigger a deployment with:"
echo "    aws apprunner start-deployment --service-arn <backend-service-arn>"
echo "    aws apprunner start-deployment --service-arn <frontend-service-arn>"
echo
echo "    Or run: make deploy  (once that target is added to the Makefile)"
