#!/usr/bin/env bash
# tf-apply.sh — Plan and apply the prod Terraform environment.
#
# Usage:
#   ./scripts/tf-apply.sh [--plan-only]
#
#   --plan-only   Run `terraform plan` only (no apply). Useful for CI checks.
#
# Prerequisites:
#   - AWS credentials for your AWS account active in the shell
#   - terraform >= 1.7 on PATH
#   - terraform.tfvars present in the prod environment directory

set -euo pipefail

TF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../infra/terraform/environments/prod" && pwd)"
VAR_FILE="$TF_DIR/terraform.tfvars"
PLAN_ONLY=false

while [[ $# -gt 0 ]]; do
  case $1 in
    --plan-only) PLAN_ONLY=true; shift ;;
    -h|--help)
      sed -n '/^# Usage/,/^[^#]/p' "$0" | grep '^#' | sed 's/^# \?//'
      exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

if [[ ! -f "$VAR_FILE" ]]; then
  echo "ERROR: $VAR_FILE not found." >&2
  echo "       Copy terraform.tfvars.example to terraform.tfvars and fill in values." >&2
  exit 1
fi

cd "$TF_DIR"
echo "==> Working directory: $TF_DIR"

echo "==> terraform init..."
terraform init -input=false

if [[ "$PLAN_ONLY" == "true" ]]; then
  echo "==> terraform plan..."
  terraform plan -var-file="$VAR_FILE" -input=false
  exit 0
fi

echo "==> terraform apply..."
terraform apply -var-file="$VAR_FILE" -input=false -auto-approve

echo
echo "==> Done."
echo "    Next steps (first deploy only):"
echo "    1. Set secrets and SSM parameters — see terraform.tfvars.example post-deploy steps."
echo "    2. Push ECR images:  ./scripts/ecr-push.sh"
