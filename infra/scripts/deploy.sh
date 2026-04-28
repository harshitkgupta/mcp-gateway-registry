#!/bin/bash
#
# Deploy MCP Gateway Registry CDK Infrastructure
#
# Usage:
#   ./deploy.sh                     # Deploy all stacks
#   ./deploy.sh --stack Registry-Network  # Deploy a single stack
#   ./deploy.sh --destroy           # Destroy all stacks
#   ./deploy.sh --destroy --stack Registry-Service  # Destroy a single stack
#   ./deploy.sh --status            # Check stack status
#   ./deploy.sh --diff              # Show pending changes
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INFRA_DIR="$(dirname "$SCRIPT_DIR")"
AWS_REGION="${AWS_REGION:-us-east-1}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Stack deployment order (CDK handles this, but useful for status display)
STACKS=(
  "Registry-Network"
  "Registry-Data"
  "Registry-Auth"
  "Registry-Service"
  "Registry-Ops"
  "Registry-Cdn"
  "Registry-Build"
)

_log_info() {
  echo -e "${BLUE}[INFO]${NC} $1"
}

_log_success() {
  echo -e "${GREEN}[OK]${NC} $1"
}

_log_warn() {
  echo -e "${YELLOW}[WARN]${NC} $1"
}

_log_error() {
  echo -e "${RED}[ERROR]${NC} $1"
}

_ensure_service_linked_role() {
  local service_name="$1"
  local short_name="${service_name%%.*}"
  local output
  if output=$(aws iam create-service-linked-role --aws-service-name "$service_name" --region "$AWS_REGION" 2>&1); then
    _log_success "Created $short_name service-linked role"
  else
    if echo "$output" | grep -q "has been taken"; then
      _log_info "$short_name service-linked role already exists"
    else
      _log_warn "Could not create $short_name service-linked role: $output"
    fi
  fi
}

_check_prerequisites() {
  local missing=0

  if ! command -v aws &> /dev/null; then
    _log_error "AWS CLI not found. Install: https://aws.amazon.com/cli/"
    missing=1
  fi

  if ! command -v node &> /dev/null; then
    _log_error "Node.js not found. Install: https://nodejs.org/"
    missing=1
  fi

  if ! command -v npx &> /dev/null; then
    _log_error "npx not found. Comes with Node.js."
    missing=1
  fi

  if [ "$missing" -eq 1 ]; then
    exit 1
  fi

  # Check AWS credentials
  if ! aws sts get-caller-identity --region "$AWS_REGION" &> /dev/null; then
    _log_error "AWS credentials not configured or expired."
    _log_error "Run: aws sso login  OR  export AWS_PROFILE=<your-profile>"
    exit 1
  fi

  local identity
  identity=$(aws sts get-caller-identity --region "$AWS_REGION" --output json)
  local account
  account=$(echo "$identity" | grep -o '"Account": "[^"]*"' | cut -d'"' -f4)
  local arn
  arn=$(echo "$identity" | grep -o '"Arn": "[^"]*"' | cut -d'"' -f4)
  _log_info "AWS Account: $account"
  _log_info "Identity: $arn"
  _log_info "Region: $AWS_REGION"

  # Ensure AWS service-linked roles exist (idempotent)
  _ensure_service_linked_role "ecs.amazonaws.com"
  _ensure_service_linked_role "elasticloadbalancing.amazonaws.com"
}

_check_secrets() {
  local required_secrets=(
    "CDK_KEYCLOAK_ADMIN_PASSWORD"
    "CDK_KEYCLOAK_DATABASE_PASSWORD"
    "CDK_DOCUMENTDB_ADMIN_PASSWORD"
  )

  local missing=0
  for secret in "${required_secrets[@]}"; do
    if [ -z "${!secret:-}" ]; then
      _log_error "Required: export $secret=\"<value>\""
      missing=1
    fi
  done

  if [ "$missing" -eq 1 ]; then
    echo ""
    _log_error "Missing required secrets. Set them before deploying:"
    echo ""
    echo "  export CDK_KEYCLOAK_ADMIN_PASSWORD=\"<password>\""
    echo "  export CDK_KEYCLOAK_DATABASE_PASSWORD=\"<password>\""
    echo "  export CDK_DOCUMENTDB_ADMIN_PASSWORD=\"<password>\""
    echo ""
    echo "Optional secrets (set if needed):"
    echo "  export CDK_EMBEDDINGS_API_KEY=\"<key>\""
    echo "  export CDK_ENTRA_CLIENT_SECRET=\"<secret>\""
    echo "  export CDK_OKTA_CLIENT_SECRET=\"<secret>\""
    echo "  export CDK_OKTA_M2M_CLIENT_SECRET=\"<secret>\""
    echo "  export CDK_AUTH0_CLIENT_SECRET=\"<secret>\""
    echo "  export CDK_AUTH0_M2M_CLIENT_SECRET=\"<secret>\""
    echo "  export CDK_GRAFANA_ADMIN_PASSWORD=\"<password>\""
    echo "  export CDK_GITHUB_PAT=\"<pat>\""
    echo "  export CDK_OTEL_EXPORTER_OTLP_HEADERS=\"<headers>\""
    echo ""
    exit 1
  fi

  _log_success "Required secrets are set"

  # Validate password characters (AWS DocumentDB/RDS restrictions)
  local password_secrets=(
    "CDK_DOCUMENTDB_ADMIN_PASSWORD"
    "CDK_KEYCLOAK_DATABASE_PASSWORD"
    "CDK_KEYCLOAK_ADMIN_PASSWORD"
  )
  local pw_invalid=0
  for secret in "${password_secrets[@]}"; do
    local val="${!secret:-}"
    if [ -n "$val" ]; then
      if echo "$val" | grep -q '[/@" ]'; then
        _log_error "$secret contains invalid characters. Cannot use: / @ \" or spaces"
        pw_invalid=1
      fi
      if [ "${#val}" -lt 8 ]; then
        _log_error "$secret must be at least 8 characters"
        pw_invalid=1
      fi
    fi
  done
  if [ "$pw_invalid" -eq 1 ]; then
    echo ""
    _log_error "Passwords must be printable ASCII, 8+ characters, without: / @ \" or spaces"
    exit 1
  fi

  # Warn about optional secrets
  local optional_secrets=(
    "CDK_EMBEDDINGS_API_KEY"
    "CDK_GRAFANA_ADMIN_PASSWORD"
  )
  for secret in "${optional_secrets[@]}"; do
    if [ -z "${!secret:-}" ]; then
      _log_warn "Optional secret not set: $secret"
    fi
  done
}

_install_deps() {
  cd "$INFRA_DIR"
  if [ ! -d "node_modules" ]; then
    _log_info "Installing npm dependencies..."
    npm install
  else
    _log_info "Dependencies already installed"
  fi
}

_build() {
  cd "$INFRA_DIR"
  _log_info "Compiling TypeScript..."
  npm run build
  _log_success "Build complete"
}

_show_status() {
  _log_info "Checking stack status..."
  echo ""

  aws cloudformation list-stacks \
    --region "$AWS_REGION" \
    --query 'StackSummaries[?starts_with(StackName, `Registry-`) && StackStatus != `DELETE_COMPLETE`].{Name:StackName,Status:StackStatus,Updated:LastUpdatedTime}' \
    --output table 2>/dev/null || echo "No Registry stacks found."

  echo ""
}

_deploy_all() {
  _check_secrets
  _install_deps
  _build

  _log_info "Synthesizing CloudFormation templates..."
  cd "$INFRA_DIR"
  npx cdk synth --quiet
  _log_success "Synth complete"

  echo ""
  _log_info "Deploying all stacks (this will take 20-40 minutes)..."
  echo ""

  local start_time
  start_time=$(date +%s)

  npx cdk deploy --all \
    --region "$AWS_REGION" \
    --require-approval never \
    --outputs-file "$INFRA_DIR/cdk-outputs.json"

  local elapsed=$(( $(date +%s) - start_time ))
  local minutes=$(( elapsed / 60 ))
  local seconds=$(( elapsed % 60 ))

  echo ""
  _log_success "All stacks deployed in ${minutes}m ${seconds}s"
  echo ""
  _show_status

  if [ -f "$INFRA_DIR/cdk-outputs.json" ]; then
    _log_info "Stack outputs saved to: infra/cdk-outputs.json"
  fi

  _show_endpoints
}

_deploy_stack() {
  local stack_name="$1"
  _check_secrets
  _install_deps
  _build

  _log_info "Deploying $stack_name..."
  cd "$INFRA_DIR"

  local start_time
  start_time=$(date +%s)

  npx cdk deploy "$stack_name" \
    --region "$AWS_REGION" \
    --require-approval never \
    --outputs-file "$INFRA_DIR/cdk-outputs.json"

  local elapsed=$(( $(date +%s) - start_time ))
  local minutes=$(( elapsed / 60 ))
  local seconds=$(( elapsed % 60 ))

  echo ""
  _log_success "$stack_name deployed in ${minutes}m ${seconds}s"
}

_destroy_all() {
  _log_warn "This will destroy ALL Registry CDK stacks!"
  echo ""
  _show_status

  read -r -p "Are you sure? Type 'yes' to confirm: " confirm
  if [ "$confirm" != "yes" ]; then
    _log_info "Aborted."
    exit 0
  fi

  _install_deps

  _log_info "Destroying all stacks (this will take 15-25 minutes)..."
  cd "$INFRA_DIR"

  local start_time
  start_time=$(date +%s)

  npx cdk destroy --all --region "$AWS_REGION" --force

  local elapsed=$(( $(date +%s) - start_time ))
  local minutes=$(( elapsed / 60 ))
  local seconds=$(( elapsed % 60 ))

  echo ""
  _log_success "All stacks destroyed in ${minutes}m ${seconds}s"

  # Clean up outputs file
  rm -f "$INFRA_DIR/cdk-outputs.json"
}

_destroy_stack() {
  local stack_name="$1"
  _log_warn "This will destroy stack: $stack_name"

  read -r -p "Are you sure? Type 'yes' to confirm: " confirm
  if [ "$confirm" != "yes" ]; then
    _log_info "Aborted."
    exit 0
  fi

  _install_deps

  _log_info "Destroying $stack_name..."
  cd "$INFRA_DIR"

  npx cdk destroy "$stack_name" --region "$AWS_REGION" --force

  _log_success "$stack_name destroyed"
}

_show_endpoints() {
  echo ""
  echo "============================================"
  echo "  Service Endpoints"
  echo "============================================"
  echo ""

  # Try cdk-outputs.json first (available after deploy)
  if [ -f "$INFRA_DIR/cdk-outputs.json" ]; then
    local registry_url auth_alb_dns keycloak_url keycloak_admin gradio_url grafana_url

    registry_url=$(python3 -c "import json; d=json.load(open('$INFRA_DIR/cdk-outputs.json')); print(d.get('Registry-Service',{}).get('RegistryUrl',''))" 2>/dev/null || true)
    keycloak_url=$(python3 -c "import json; d=json.load(open('$INFRA_DIR/cdk-outputs.json')); print(d.get('Registry-Auth',{}).get('KeycloakUrl','') or d.get('Registry-Service',{}).get('KeycloakUrl',''))" 2>/dev/null || true)
    keycloak_admin=$(python3 -c "import json; d=json.load(open('$INFRA_DIR/cdk-outputs.json')); print(d.get('Registry-Auth',{}).get('KeycloakAdminConsole',''))" 2>/dev/null || true)
    gradio_url=$(python3 -c "import json; d=json.load(open('$INFRA_DIR/cdk-outputs.json')); print(d.get('Registry-Service',{}).get('GradioUiUrl',''))" 2>/dev/null || true)
    grafana_url=$(python3 -c "import json; d=json.load(open('$INFRA_DIR/cdk-outputs.json')); print(d.get('Registry-Service',{}).get('GrafanaUrl',''))" 2>/dev/null || true)

    [ -n "$registry_url" ]    && echo -e "  Registry UI:       ${GREEN}${registry_url}${NC}"
    [ -n "$registry_url" ]    && echo -e "  Registry API:      ${GREEN}${registry_url}/api/v1${NC}"
    [ -n "$registry_url" ]    && echo -e "  Registry Health:   ${GREEN}${registry_url}/health${NC}"
    [ -n "$keycloak_url" ]    && echo -e "  Keycloak:          ${GREEN}${keycloak_url}${NC}"
    [ -n "$keycloak_admin" ]  && echo -e "  Keycloak Admin:    ${GREEN}${keycloak_admin}${NC}"
    [ -n "$gradio_url" ]      && echo -e "  Gradio UI:         ${GREEN}${gradio_url}${NC}"
    [ -n "$grafana_url" ]     && echo -e "  Grafana:           ${GREEN}${grafana_url}${NC}"
    echo ""
    return
  fi

  # Fallback: query CloudFormation outputs directly
  _log_info "Querying CloudFormation stack outputs..."
  echo ""

  for stack_name in Registry-Auth Registry-Service; do
    local outputs
    outputs=$(aws cloudformation describe-stacks \
      --region "$AWS_REGION" \
      --stack-name "$stack_name" \
      --query 'Stacks[0].Outputs[].{Key:OutputKey,Value:OutputValue}' \
      --output text 2>/dev/null || true)

    if [ -n "$outputs" ]; then
      while IFS=$'\t' read -r key value; do
        case "$key" in
          RegistryUrl)        echo -e "  Registry UI:       ${GREEN}${value}${NC}" ;;
          RegistryAlbDnsName) echo -e "  Registry ALB:      ${GREEN}${value}${NC}" ;;
          KeycloakUrl)        echo -e "  Keycloak:          ${GREEN}${value}${NC}" ;;
          KeycloakAdminConsole) echo -e "  Keycloak Admin:  ${GREEN}${value}${NC}" ;;
          KeycloakAlbDnsName) echo -e "  Keycloak ALB:      ${GREEN}${value}${NC}" ;;
          GradioUiUrl)        echo -e "  Gradio UI:         ${GREEN}${value}${NC}" ;;
          GrafanaUrl)         echo -e "  Grafana:           ${GREEN}${value}${NC}" ;;
        esac
      done <<< "$outputs"
    fi
  done

  echo ""
  echo "  Quick verification:"
  echo "    curl -s \$(./infra/scripts/deploy.sh --endpoints 2>/dev/null | grep 'Health' | awk '{print \$NF}')"
  echo ""
}

_show_diff() {
  _install_deps
  _build

  _log_info "Showing pending changes..."
  cd "$INFRA_DIR"
  npx cdk diff --region "$AWS_REGION" 2>&1 || true
}

_show_usage() {
  echo "Usage: $0 [OPTIONS]"
  echo ""
  echo "Options:"
  echo "  (no args)             Deploy all stacks"
  echo "  --stack <name>        Target a specific stack (with --destroy or alone)"
  echo "  --destroy             Destroy stacks (all or specific with --stack)"
  echo "  --status              Show current stack status"
  echo "  --diff                Show pending changes (cdk diff)"
  echo "  --endpoints           Show service endpoints from deployed stacks"
  echo "  --help                Show this help message"
  echo ""
  echo "Examples:"
  echo "  $0                                  # Deploy all stacks"
  echo "  $0 --stack Registry-Service         # Deploy only Registry-Service"
  echo "  $0 --destroy                        # Destroy all stacks"
  echo "  $0 --destroy --stack Registry-Service  # Destroy one stack"
  echo "  $0 --status                         # Check stack status"
  echo "  $0 --diff                           # Preview changes"
  echo "  $0 --endpoints                      # Show service URLs"
  echo ""
  echo "Required environment variables:"
  echo "  CDK_KEYCLOAK_ADMIN_PASSWORD"
  echo "  CDK_KEYCLOAK_DATABASE_PASSWORD"
  echo "  CDK_DOCUMENTDB_ADMIN_PASSWORD"
  echo ""
  echo "Optional:"
  echo "  AWS_REGION (default: us-east-1)"
  echo "  CDK_EMBEDDINGS_API_KEY"
  echo "  CDK_GRAFANA_ADMIN_PASSWORD"
  echo "  CDK_ENTRA_CLIENT_SECRET, CDK_OKTA_CLIENT_SECRET, CDK_AUTH0_CLIENT_SECRET"
  echo "  CDK_GITHUB_PAT, CDK_OTEL_EXPORTER_OTLP_HEADERS"
  echo ""
  echo "Stacks (deployment order):"
  for stack in "${STACKS[@]}"; do
    echo "  - $stack"
  done
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

ACTION="deploy"
TARGET_STACK=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --destroy)
      ACTION="destroy"
      shift
      ;;
    --stack)
      TARGET_STACK="$2"
      shift 2
      ;;
    --status)
      ACTION="status"
      shift
      ;;
    --diff)
      ACTION="diff"
      shift
      ;;
    --endpoints)
      ACTION="endpoints"
      shift
      ;;
    --help|-h)
      _show_usage
      exit 0
      ;;
    *)
      _log_error "Unknown option: $1"
      _show_usage
      exit 1
      ;;
  esac
done

echo ""
echo "============================================"
echo "  MCP Gateway Registry - CDK Deployment"
echo "============================================"
echo ""

_check_prerequisites

case "$ACTION" in
  deploy)
    if [ -n "$TARGET_STACK" ]; then
      _deploy_stack "$TARGET_STACK"
    else
      _deploy_all
    fi
    ;;
  destroy)
    if [ -n "$TARGET_STACK" ]; then
      _destroy_stack "$TARGET_STACK"
    else
      _destroy_all
    fi
    ;;
  status)
    _show_status
    ;;
  diff)
    _show_diff
    ;;
  endpoints)
    _show_endpoints
    ;;
esac
