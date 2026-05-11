#!/bin/bash
#
# Post-deploy automation for MCP Gateway Registry.
#
# Runs after CDK deploy to configure Keycloak and wire up secrets
# so the deployment is fully functional without manual steps.
#
# Usage:
#   ./infra/scripts/post-deploy.sh
#
# Requires:
#   - AWS CLI configured with valid credentials
#   - CDK_KEYCLOAK_ADMIN_PASSWORD environment variable set
#   - jq installed
#   - cdk-outputs.json from a successful CDK deploy
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INFRA_DIR="$(dirname "$SCRIPT_DIR")"
PROJECT_ROOT="$(dirname "$INFRA_DIR")"
AWS_REGION="${AWS_REGION:-us-east-1}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

_log_info()    { echo -e "${BLUE}[INFO]${NC} $1"; }
_log_success() { echo -e "${GREEN}[OK]${NC} $1"; }
_log_warn()    { echo -e "${YELLOW}[WARN]${NC} $1"; }
_log_error()   { echo -e "${RED}[ERROR]${NC} $1"; }

# ---------------------------------------------------------------------------
# Read endpoints from cdk-outputs.json
# ---------------------------------------------------------------------------

_read_outputs() {
  local outputs_file="$INFRA_DIR/cdk-outputs.json"
  if [ ! -f "$outputs_file" ]; then
    _log_error "cdk-outputs.json not found. Run CDK deploy first."
    exit 1
  fi

  KEYCLOAK_URL=$(python3 -c "
import json
d = json.load(open('$outputs_file'))
print(d.get('Registry-Service', {}).get('KeycloakUrl', '') or d.get('Registry-Auth', {}).get('KeycloakUrl', ''))
" 2>/dev/null)

  REGISTRY_URL=$(python3 -c "
import json
d = json.load(open('$outputs_file'))
print(d.get('Registry-Service', {}).get('RegistryUrl', ''))
" 2>/dev/null)

  GRADIO_URL=$(python3 -c "
import json
d = json.load(open('$outputs_file'))
print(d.get('Registry-Service', {}).get('GradioUiUrl', ''))
" 2>/dev/null)

  GRAFANA_URL=$(python3 -c "
import json
d = json.load(open('$outputs_file'))
print(d.get('Registry-Service', {}).get('GrafanaUrl', ''))
" 2>/dev/null)

  if [ -z "$KEYCLOAK_URL" ] || [ -z "$REGISTRY_URL" ]; then
    _log_error "Could not read Keycloak/Registry URLs from cdk-outputs.json"
    exit 1
  fi

  _log_info "Keycloak URL: $KEYCLOAK_URL"
  _log_info "Registry URL: $REGISTRY_URL"
}

# ---------------------------------------------------------------------------
# Wait for Keycloak ALB to be healthy
# ---------------------------------------------------------------------------

_wait_for_keycloak() {
  _log_info "Waiting for Keycloak to be ready..."
  local max_attempts=60
  local attempt=0

  while [ $attempt -lt $max_attempts ]; do
    local http_code
    http_code=$(curl -s -o /dev/null -w "%{http_code}" "${KEYCLOAK_URL}/" 2>/dev/null || echo "000")
    if [ "$http_code" = "200" ] || [ "$http_code" = "302" ] || [ "$http_code" = "303" ]; then
      _log_success "Keycloak is ready (HTTP $http_code)"
      return 0
    fi
    sleep 5
    attempt=$((attempt + 1))
  done

  _log_error "Keycloak did not become ready within 5 minutes"
  exit 1
}

# ---------------------------------------------------------------------------
# Get Keycloak admin token
# ---------------------------------------------------------------------------

_get_admin_token() {
  local token
  token=$(curl -s -X POST "${KEYCLOAK_URL}/realms/master/protocol/openid-connect/token" \
    -H "Content-Type: application/x-www-form-urlencoded" \
    -d "username=${KC_ADMIN_USER}" \
    -d "password=${KC_ADMIN_PASSWORD}" \
    -d "grant_type=password" \
    -d "client_id=admin-cli" | jq -r '.access_token // empty')

  if [ -z "$token" ]; then
    _log_error "Failed to authenticate with Keycloak"
    exit 1
  fi

  echo "$token"
}

# ---------------------------------------------------------------------------
# Disable sslRequired on a realm via Admin API (requires valid token)
# ---------------------------------------------------------------------------

_disable_ssl_required() {
  local token="$1"
  local realm="$2"

  local http_code
  http_code=$(curl -s -o /dev/null -w "%{http_code}" \
    -X PUT "${KEYCLOAK_URL}/admin/realms/${realm}" \
    -H "Authorization: Bearer ${token}" \
    -H "Content-Type: application/json" \
    -d '{"sslRequired":"NONE"}')

  if [ "$http_code" = "204" ]; then
    _log_success "Disabled sslRequired on realm: ${realm}"
  else
    _log_warn "Could not disable sslRequired on ${realm} (HTTP ${http_code})"
  fi
}

# ---------------------------------------------------------------------------
# Disable sslRequired on master realm via ECS Exec (kcadm.sh on localhost)
# This bypasses the ALB and avoids the HTTPS-required chicken-and-egg problem
# on fresh deploys where the master realm defaults to sslRequired=EXTERNAL.
# ---------------------------------------------------------------------------

_disable_ssl_via_ecs_exec() {
  _log_info "Disabling SSL requirement on master realm via ECS Exec..."

  local task_arn
  task_arn=$(aws ecs list-tasks --cluster keycloak --service-name keycloak \
    --region "$AWS_REGION" --desired-status RUNNING \
    --query 'taskArns[0]' --output text 2>/dev/null)

  if [ -z "$task_arn" ] || [ "$task_arn" = "None" ]; then
    _log_error "No running Keycloak task found"
    return 1
  fi

  local task_id="${task_arn##*/}"

  local kcadm_cmd="/opt/keycloak/bin/kcadm.sh"
  local script="$kcadm_cmd config credentials --server http://localhost:8080 --realm master --user ${KC_ADMIN_USER} --password ${KC_ADMIN_PASSWORD} 2>&1 && $kcadm_cmd update realms/master -s sslRequired=NONE 2>&1 && echo SSL_DISABLED_OK"

  local output
  output=$(aws ecs execute-command --cluster keycloak --task "$task_id" \
    --container keycloak --interactive \
    --command "sh -c '${script}'" \
    --region "$AWS_REGION" 2>&1) || true

  if echo "$output" | grep -q "SSL_DISABLED_OK"; then
    _log_success "Disabled sslRequired on master realm via ECS Exec"
    return 0
  fi

  _log_warn "ECS Exec output: $output"
  _log_warn "ECS Exec may have timed out but the command may still succeed. Verifying..."

  local verify_attempt=0
  local max_verify=12
  while [ $verify_attempt -lt $max_verify ]; do
    sleep 5
    local http_code
    http_code=$(curl -s -o /dev/null -w "%{http_code}" \
      -X POST "${KEYCLOAK_URL}/realms/master/protocol/openid-connect/token" \
      -H "Content-Type: application/x-www-form-urlencoded" \
      -d "username=${KC_ADMIN_USER}" \
      -d "password=${KC_ADMIN_PASSWORD}" \
      -d "grant_type=password" \
      -d "client_id=admin-cli" 2>/dev/null || echo "000")

    if [ "$http_code" = "200" ]; then
      _log_success "Verified: master realm SSL is now disabled (token request returned 200)"
      return 0
    fi
    _log_info "Waiting for SSL disable to take effect (attempt $((verify_attempt + 1))/$max_verify, HTTP $http_code)..."
    verify_attempt=$((verify_attempt + 1))
  done

  _log_error "Failed to disable SSL on master realm after ${max_verify} attempts"
  return 1
}

# ---------------------------------------------------------------------------
# Run init-keycloak.sh to create realm, clients, groups, users
# ---------------------------------------------------------------------------

_init_keycloak() {
  local init_script="$PROJECT_ROOT/keycloak/setup/init-keycloak.sh"
  if [ ! -f "$init_script" ]; then
    _log_error "init-keycloak.sh not found at $init_script"
    exit 1
  fi

  _log_info "Running Keycloak initialization (realm, clients, groups, users)..."

  # Create temporary .env for the init script
  local tmp_env="$PROJECT_ROOT/.env"
  local cleanup_env=false
  if [ ! -f "$tmp_env" ]; then
    cleanup_env=true
    cat > "$tmp_env" <<ENVEOF
KEYCLOAK_ADMIN_URL=${KEYCLOAK_URL}
KEYCLOAK_ADMIN=${KC_ADMIN_USER}
KEYCLOAK_ADMIN_PASSWORD=${KC_ADMIN_PASSWORD}
REGISTRY_URL=${REGISTRY_URL}
AUTH_SERVER_EXTERNAL_URL=${REGISTRY_URL}
INITIAL_ADMIN_PASSWORD=${KC_ADMIN_PASSWORD}
INITIAL_USER_PASSWORD=testpass123
ENVEOF
  fi

  (cd "$PROJECT_ROOT" && bash "$init_script") || {
    _log_error "init-keycloak.sh failed"
    [ "$cleanup_env" = true ] && rm -f "$tmp_env"
    exit 1
  }

  [ "$cleanup_env" = true ] && rm -f "$tmp_env"
  _log_success "Keycloak initialization complete"
}

# ---------------------------------------------------------------------------
# Extract client secrets and update Secrets Manager
# ---------------------------------------------------------------------------

_update_client_secrets() {
  _log_info "Updating Secrets Manager with Keycloak client secrets..."

  local token
  token=$(_get_admin_token)

  # Get web client secret
  local web_client_uuid
  web_client_uuid=$(curl -s -H "Authorization: Bearer ${token}" \
    "${KEYCLOAK_URL}/admin/realms/mcp-gateway/clients?clientId=mcp-gateway-web" | \
    jq -r '.[0].id // empty')

  if [ -z "$web_client_uuid" ]; then
    _log_error "Could not find mcp-gateway-web client"
    return 1
  fi

  local web_secret
  web_secret=$(curl -s -H "Authorization: Bearer ${token}" \
    "${KEYCLOAK_URL}/admin/realms/mcp-gateway/clients/${web_client_uuid}/client-secret" | \
    jq -r '.value // empty')

  # Get M2M client secret
  local m2m_client_uuid
  m2m_client_uuid=$(curl -s -H "Authorization: Bearer ${token}" \
    "${KEYCLOAK_URL}/admin/realms/mcp-gateway/clients?clientId=mcp-gateway-m2m" | \
    jq -r '.[0].id // empty')

  if [ -z "$m2m_client_uuid" ]; then
    _log_error "Could not find mcp-gateway-m2m client"
    return 1
  fi

  local m2m_secret
  m2m_secret=$(curl -s -H "Authorization: Bearer ${token}" \
    "${KEYCLOAK_URL}/admin/realms/mcp-gateway/clients/${m2m_client_uuid}/client-secret" | \
    jq -r '.value // empty')

  if [ -z "$web_secret" ] || [ -z "$m2m_secret" ]; then
    _log_error "Could not retrieve client secrets from Keycloak"
    return 1
  fi

  # Update Secrets Manager
  aws secretsmanager put-secret-value \
    --region "$AWS_REGION" \
    --secret-id mcp-gateway-keycloak-client-secret \
    --secret-string "{\"client_secret\":\"${web_secret}\"}" > /dev/null 2>&1

  aws secretsmanager put-secret-value \
    --region "$AWS_REGION" \
    --secret-id mcp-gateway-keycloak-m2m-client-secret \
    --secret-string "{\"client_secret\":\"${m2m_secret}\"}" > /dev/null 2>&1

  _log_success "Secrets Manager updated with real client secrets"
}

# ---------------------------------------------------------------------------
# Restart registry and auth-server ECS services
# ---------------------------------------------------------------------------

_restart_services() {
  _log_info "Restarting registry and auth-server to pick up new secrets..."

  local cluster="mcp-gateway-ecs-cluster"

  aws ecs update-service --region "$AWS_REGION" \
    --cluster "$cluster" --service mcp-gateway-registry \
    --force-new-deployment > /dev/null 2>&1

  aws ecs update-service --region "$AWS_REGION" \
    --cluster "$cluster" --service mcp-gateway-auth-server \
    --force-new-deployment > /dev/null 2>&1

  _log_info "Waiting for services to stabilize (this takes 2-4 minutes)..."

  aws ecs wait services-stable --region "$AWS_REGION" \
    --cluster "$cluster" \
    --services mcp-gateway-registry mcp-gateway-auth-server 2>/dev/null || {
    _log_warn "Services did not stabilize within timeout. Check ECS console."
  }

  _log_success "Services restarted"
}

# ---------------------------------------------------------------------------
# Load scopes into DocumentDB via ECS Exec on the registry container
# ---------------------------------------------------------------------------

_load_scopes() {
  _log_info "Loading scopes configuration into DocumentDB..."

  local cluster="mcp-gateway-ecs-cluster"
  local task_arn
  task_arn=$(aws ecs list-tasks --cluster "$cluster" --service-name mcp-gateway-registry \
    --region "$AWS_REGION" --desired-status RUNNING \
    --query 'taskArns[0]' --output text 2>/dev/null)

  if [ -z "$task_arn" ] || [ "$task_arn" = "None" ]; then
    _log_error "No running registry task found for scopes loading"
    return 1
  fi

  local task_id="${task_arn##*/}"

  local output
  output=$(aws ecs execute-command --cluster "$cluster" --task "$task_id" \
    --container registry --interactive \
    --command "sh -c '/app/.venv/bin/python scripts/load-scopes.py --scopes-file /app/config/scopes.yml 2>&1'" \
    --region "$AWS_REGION" 2>&1) || true

  if echo "$output" | grep -q "Successfully loaded\|Scopes loading complete"; then
    _log_success "Scopes loaded into DocumentDB"
    return 0
  fi

  if echo "$output" | grep -q "No changes for scope\|Updated scope"; then
    _log_success "Scopes already loaded (no changes needed)"
    return 0
  fi

  _log_warn "ECS Exec scopes output: $output"
  _log_warn "Scopes loading may have failed. Check registry logs."
  return 1
}

# ---------------------------------------------------------------------------
# Load UI-scope documents into DocumentDB
# The built-in load-scopes.py only creates docs for top-level YAML keys (MCP
# server scopes). UI-scope names (registry-admins, etc.) that define
# publish_agent and other UI permissions exist only under UI-Scopes and need
# separate documents. Without them, group_mappings lookups and ui_permissions
# resolution fail, causing 403 on agent registration.
# ---------------------------------------------------------------------------

_load_ui_scopes() {
  _log_info "Loading UI-scope documents into DocumentDB..."

  local cluster="mcp-gateway-ecs-cluster"
  local task_arn
  task_arn=$(aws ecs list-tasks --cluster "$cluster" --service-name mcp-gateway-registry \
    --region "$AWS_REGION" --desired-status RUNNING \
    --query 'taskArns[0]' --output text 2>/dev/null)

  if [ -z "$task_arn" ] || [ "$task_arn" = "None" ]; then
    _log_error "No running registry task found for UI scopes loading"
    return 1
  fi

  local task_id="${task_arn##*/}"

  # Base64-encode the Python script to avoid nested quoting issues in ECS Exec.
  # Uses the registry's own get_documentdb_client() which handles TLS/auth correctly.
  local py_b64
  py_b64=$(printf '%s\n' \
'import asyncio, sys, os, yaml' \
'sys.path.insert(0, "/app")' \
'from registry.repositories.documentdb.client import get_documentdb_client, get_collection_name' \
'async def main():' \
'    sf = "/app/config/scopes.yml"' \
'    if not os.path.exists(sf): sf = "/app/registry/config/scopes.yml"' \
'    with open(sf) as f: data = yaml.safe_load(f)' \
'    ui = data.get("UI-Scopes", {})' \
'    gm = data.get("group_mappings", {})' \
'    top = set(k for k in data if k not in ("group_mappings", "UI-Scopes"))' \
'    db = await get_documentdb_client()' \
'    coll_name = get_collection_name("mcp_scopes")' \
'    co = db[coll_name]' \
'    n = 0' \
'    for name, perms in ui.items():' \
'        if name in top: continue' \
'        grps = [g for g, s in gm.items() if name in s]' \
'        doc = {"_id": name, "group_mappings": grps, "server_access": [], "ui_permissions": perms}' \
'        r = await co.update_one({"_id": name}, {"$set": doc}, upsert=True)' \
'        if r.upserted_id or r.modified_count > 0:' \
'            n += 1' \
'            print(f"Upserted: {name} groups={grps}")' \
'        else: print(f"Exists: {name}")' \
'    print(f"UI_SCOPES_LOADED_OK: {n} documents")' \
'asyncio.run(main())' | base64)

  local output
  output=$(aws ecs execute-command --cluster "$cluster" --task "$task_id" \
    --container registry --interactive \
    --command "sh -c 'echo ${py_b64} | base64 -d | /app/.venv/bin/python 2>&1'" \
    --region "$AWS_REGION" 2>&1) || true

  if echo "$output" | grep -q "UI_SCOPES_LOADED_OK"; then
    _log_success "UI-scope documents loaded into DocumentDB"
    return 0
  fi

  _log_warn "UI scopes ECS Exec output: $output"
  _log_warn "UI scopes loading may have failed."
  return 1
}

# ---------------------------------------------------------------------------
# Validate all endpoints
# ---------------------------------------------------------------------------

_validate_endpoints() {
  _log_info "Validating service endpoints..."
  echo ""

  local all_ok=true

  for url_label in \
    "Registry|${REGISTRY_URL}/health" \
    "Gradio UI|${GRADIO_URL:-${REGISTRY_URL}:7860}/health" \
    "Auth Server|${REGISTRY_URL}:8888/health" \
    "Keycloak|${KEYCLOAK_URL}/" \
    "Keycloak Realm|${KEYCLOAK_URL}/realms/mcp-gateway/.well-known/openid-configuration"; do

    local label="${url_label%%|*}"
    local url="${url_label##*|}"
    local http_code
    http_code=$(curl -s -o /dev/null -w "%{http_code}" "$url" 2>/dev/null || echo "000")

    if [ "$http_code" = "200" ] || [ "$http_code" = "302" ] || [ "$http_code" = "303" ]; then
      echo -e "  ${GREEN}[PASS]${NC} $label ($http_code)"
    else
      echo -e "  ${RED}[FAIL]${NC} $label ($http_code)"
      all_ok=false
    fi
  done

  echo ""

  if [ "$all_ok" = false ]; then
    _log_warn "Some endpoints are not responding. Check ECS task logs."
  fi
}

# ---------------------------------------------------------------------------
# Print summary with URLs and credentials
# ---------------------------------------------------------------------------

_print_summary() {
  local grafana_password="${CDK_GRAFANA_ADMIN_PASSWORD:-GrafanaAdmin2026}"

  echo ""
  echo "============================================"
  echo "  Deployment Complete"
  echo "============================================"
  echo ""
  echo "  Service URLs"
  echo "  ------------"
  echo -e "  Registry:          ${GREEN}${REGISTRY_URL}${NC}"
  echo -e "  Registry API:      ${GREEN}${REGISTRY_URL}/api/v1${NC}"
  echo -e "  Gradio UI:         ${GREEN}${GRADIO_URL:-${REGISTRY_URL}:7860}${NC}"
  echo -e "  Auth Server:       ${GREEN}${REGISTRY_URL}:8888${NC}"
  echo -e "  Keycloak:          ${GREEN}${KEYCLOAK_URL}${NC}"
  echo -e "  Keycloak Admin:    ${GREEN}${KEYCLOAK_URL}/admin${NC}"
  if [ -n "${GRAFANA_URL:-}" ]; then
    echo -e "  Grafana:           ${GREEN}${GRAFANA_URL}${NC}"
  fi
  echo ""
  echo "  Login Credentials"
  echo "  -----------------"
  echo "  Registry / Gradio UI (Keycloak SSO):"
  echo -e "    Admin user:      ${YELLOW}admin${NC} / ${YELLOW}${KC_ADMIN_PASSWORD}${NC}"
  echo -e "    Test user:       ${YELLOW}testuser${NC} / ${YELLOW}testpass123${NC}"
  echo ""
  echo "  Keycloak Admin Console:"
  echo -e "    Username:        ${YELLOW}${KC_ADMIN_USER}${NC}"
  echo -e "    Password:        ${YELLOW}${KC_ADMIN_PASSWORD}${NC}"
  echo ""
  if [ -n "${GRAFANA_URL:-}" ]; then
    echo "  Grafana:"
    echo -e "    Username:        ${YELLOW}admin${NC}"
    echo -e "    Password:        ${YELLOW}${grafana_password}${NC}"
    echo ""
  fi
  echo "============================================"
  echo ""
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

main() {
  echo ""
  echo "============================================"
  echo "  Post-Deploy Configuration"
  echo "============================================"
  echo ""

  # Validate required env vars
  KC_ADMIN_USER="admin"
  KC_ADMIN_PASSWORD="${CDK_KEYCLOAK_ADMIN_PASSWORD:-}"

  if [ -z "$KC_ADMIN_PASSWORD" ]; then
    _log_error "CDK_KEYCLOAK_ADMIN_PASSWORD is not set"
    exit 1
  fi

  # Step 1: Read endpoints from CDK outputs
  _read_outputs

  # Step 2: Wait for Keycloak
  _wait_for_keycloak

  # Step 3: Disable SSL on master realm via ECS Exec (bypasses ALB HTTPS requirement)
  # On fresh deploys, ECS Exec (SSM agent) may not be ready immediately.
  # Retry with backoff to handle the SSM agent registration delay.
  local ssl_disabled=false
  local ssl_attempt=0
  local ssl_max_attempts=3
  while [ $ssl_attempt -lt $ssl_max_attempts ]; do
    if _disable_ssl_via_ecs_exec; then
      ssl_disabled=true
      break
    fi
    ssl_attempt=$((ssl_attempt + 1))
    if [ $ssl_attempt -lt $ssl_max_attempts ]; then
      _log_warn "ECS Exec not ready (attempt $ssl_attempt/$ssl_max_attempts). Waiting 30s for SSM agent..."
      sleep 30
    fi
  done

  if [ "$ssl_disabled" = false ]; then
    _log_error "Failed to disable SSL after $ssl_max_attempts attempts. Cannot proceed with Keycloak init."
    _log_error "Run post-deploy.sh manually once ECS Exec is available."
    exit 1
  fi

  # Step 4: Initialize Keycloak (realm, clients, groups, users)
  _init_keycloak

  # Step 5: Disable SSL requirement on mcp-gateway realm (via Admin API - now accessible)
  _log_info "Disabling SSL requirement on mcp-gateway realm..."
  local token
  token=$(_get_admin_token)
  _disable_ssl_required "$token" "mcp-gateway"

  # Step 6: Update Secrets Manager with real client secrets
  _update_client_secrets

  # Step 7: Load scopes into DocumentDB (before restart — current task has SSM ready)
  local scopes_loaded=false
  local scopes_attempt=0
  local scopes_max_attempts=3
  while [ $scopes_attempt -lt $scopes_max_attempts ]; do
    if _load_scopes; then
      scopes_loaded=true
      break
    fi
    scopes_attempt=$((scopes_attempt + 1))
    if [ $scopes_attempt -lt $scopes_max_attempts ]; then
      _log_warn "Scopes loading failed (attempt $scopes_attempt/$scopes_max_attempts). Retrying in 20s..."
      sleep 20
    fi
  done

  if [ "$scopes_loaded" = false ]; then
    _log_warn "Scopes could not be loaded after $scopes_max_attempts attempts."
    _log_warn "Run manually: ./infra/scripts/post-deploy.sh (or use ECS Exec to run load-scopes.py)"
    _log_warn "Without scopes, agent registration will fail with 403."
  fi

  # Step 7b: Load UI-scope documents (registry-admins, etc.) that load-scopes.py misses.
  # These are required for publish_agent and other UI permission resolution.
  if [ "$scopes_loaded" = true ]; then
    _load_ui_scopes || _log_warn "UI scopes loading failed. Agent registration may return 403."
  fi

  # Step 8: Restart registry and auth-server services (picks up new secrets)
  _restart_services

  # Step 9: Validate all endpoints
  _validate_endpoints

  # Step 10: Print summary
  _print_summary
}

main "$@"
