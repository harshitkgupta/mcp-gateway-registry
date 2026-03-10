#!/bin/bash
set -e

echo "=== Testing MCP Gateway ==="
echo ""

# Check for required environment variable
if [ -z "$KEYCLOAK_M2M_SECRET" ]; then
  echo "Error: KEYCLOAK_M2M_SECRET environment variable not set"
  echo "Set it with: export KEYCLOAK_M2M_SECRET=your_secret_here"
  echo "Or retrieve from AWS Secrets Manager:"
  echo "  export KEYCLOAK_M2M_SECRET=\$(aws secretsmanager get-secret-value --secret-id mcp-gateway/keycloak-m2m-secret --query SecretString --output text | jq -r .client_secret)"
  exit 1
fi

# Step 1: Get M2M token from Keycloak
echo "1. Getting M2M token from Keycloak..."
TOKEN_RESPONSE=$(curl -s -X POST 'http://localhost:8080/realms/mcp-gateway/protocol/openid-connect/token' \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -d 'grant_type=client_credentials' \
  -d 'client_id=mcp-gateway-m2m' \
  -d "client_secret=$KEYCLOAK_M2M_SECRET" \
  -d 'scope=openid')

TOKEN=$(echo "$TOKEN_RESPONSE" | jq -r '.access_token')

if [ "$TOKEN" = "null" ] || [ -z "$TOKEN" ]; then
  echo "ERROR: Failed to get token"
  echo "$TOKEN_RESPONSE" | jq .
  exit 1
fi

echo "✓ Got token: ${TOKEN:0:50}..."
echo ""

# Step 2: Test ping endpoint
echo "2. Testing /mcpgw/mcp ping endpoint..."
PING_RESPONSE=$(curl -s -X POST http://localhost/mcpgw/mcp \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"jsonrpc": "2.0", "method": "ping", "id": 1}')

echo "Response:"
echo "$PING_RESPONSE" | jq . 2>/dev/null || echo "$PING_RESPONSE"
echo ""

# Step 3: Test initialize
echo "3. Testing initialize..."
INIT_RESPONSE=$(curl -s -X POST http://localhost/mcpgw/mcp \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"jsonrpc": "2.0", "method": "initialize", "params": {"protocolVersion": "2024-11-05", "capabilities": {}, "clientInfo": {"name": "test", "version": "1.0"}}, "id": 2}')

echo "Response:"
echo "$INIT_RESPONSE" | jq . 2>/dev/null || echo "$INIT_RESPONSE"
echo ""

echo "=== Test Complete ==="
