#!/bin/bash
# Run DocumentDB management commands via ECS task
#
# This script runs the manage-documentdb.py script inside an ECS task
# with proper network access to the DocumentDB cluster in the VPC.
#
# Usage:
#   ./terraform/aws-ecs/scripts/run-documentdb-cli.sh list
#   ./terraform/aws-ecs/scripts/run-documentdb-cli.sh inspect mcp_servers_default
#   ./terraform/aws-ecs/scripts/run-documentdb-cli.sh count mcp_servers_default
#   ./terraform/aws-ecs/scripts/run-documentdb-cli.sh search mcp_servers_default 5
#   ./terraform/aws-ecs/scripts/run-documentdb-cli.sh sample mcp_servers_default
#   ./terraform/aws-ecs/scripts/run-documentdb-cli.sh query mcp_servers_default '{"enabled": true}'

set -e

# Get the directory where this script is located
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
TERRAFORM_DIR="$(dirname "$SCRIPT_DIR")"
PROJECT_ROOT="$(dirname "$(dirname "$TERRAFORM_DIR")")"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Show help function
show_help() {
    cat << EOF
DocumentDB Management CLI

Usage: $0 <command> [options]

Commands:
  list                           List all collections in the database
  inspect <collection>           Inspect collection schema and stats
  count <collection>             Count documents in a collection
  search <collection> [limit]    Search documents in a collection (default limit: 10)
  sample <collection>            Show a sample document from collection
  query <collection> <filter>    Query documents with MongoDB filter JSON

Options:
  -h, --help                     Show this help message

Examples:
  $0 list
  $0 inspect mcp_servers_default
  $0 count mcp_scopes_default
  $0 search mcp_servers_default 20
  $0 sample mcp_servers_default
  $0 query mcp_servers_default '{"enabled": true}'
  $0 query mcp_servers_default '{"path": "/currenttime"}'

Environment Variables:
  DOCUMENTDB_HOST                Override DocumentDB endpoint (optional)
  AWS_REGION                     AWS region (default: us-east-1)

The script automatically reads the DocumentDB endpoint from SSM Parameter Store
if available, otherwise falls back to DOCUMENTDB_HOST environment variable.
EOF
    exit 0
}

# Check for help flag
if [ "$1" = "-h" ] || [ "$1" = "--help" ]; then
    show_help
fi

# Parse command
COMMAND=${1:-list}
shift || true

# Build command arguments
case "$COMMAND" in
    list)
        PYTHON_ARGS="list"
        ;;

    inspect|count|sample)
        COLLECTION_NAME=${1:-}
        if [ -z "$COLLECTION_NAME" ]; then
            echo -e "${RED}Error: Collection name required for $COMMAND command${NC}"
            echo "Usage: $0 $COMMAND <collection-name>"
            echo "Run '$0 --help' for more information"
            exit 1
        fi
        shift || true
        PYTHON_ARGS="$COMMAND --collection $COLLECTION_NAME"
        ;;

    search)
        COLLECTION_NAME=${1:-}
        LIMIT=${2:-10}
        if [ -z "$COLLECTION_NAME" ]; then
            echo -e "${RED}Error: Collection name required for search command${NC}"
            echo "Usage: $0 search <collection-name> [limit]"
            echo "Run '$0 --help' for more information"
            exit 1
        fi
        PYTHON_ARGS="search --collection $COLLECTION_NAME --limit $LIMIT"
        ;;

    query)
        COLLECTION_NAME=${1:-}
        FILTER_JSON=${2:-}
        LIMIT=${3:-10}
        if [ -z "$COLLECTION_NAME" ] || [ -z "$FILTER_JSON" ]; then
            echo -e "${RED}Error: Collection name and filter required for query command${NC}"
            echo "Usage: $0 query <collection-name> '<filter-json>' [limit]"
            echo "Example: $0 query mcp_servers_default '{\"enabled\": true}'"
            echo "Run '$0 --help' for more information"
            exit 1
        fi
        PYTHON_ARGS="query --collection $COLLECTION_NAME --filter '$FILTER_JSON' --limit $LIMIT"
        ;;

    *)
        echo -e "${RED}Unknown command: $COMMAND${NC}"
        echo ""
        echo "Available commands:"
        echo "  list                           - List all collections"
        echo "  inspect <collection>           - Inspect collection schema and stats"
        echo "  count <collection>             - Count documents"
        echo "  search <collection> [limit]    - Search documents (default limit: 10)"
        echo "  sample <collection>            - Show sample document"
        echo "  query <collection> <filter>    - Query with MongoDB filter"
        echo ""
        echo "Run '$0 --help' for detailed usage information"
        exit 1
        ;;
esac

# Get AWS account and region
AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
AWS_REGION="${AWS_REGION:-us-east-1}"

# ECS configuration
CLUSTER_NAME="mcp-gateway-ecs-cluster"
TASK_FAMILY="mcp-gateway-v2-registry"
CONTAINER_NAME="registry"

# Get DocumentDB host from SSM Parameter Store
if [ -z "$DOCUMENTDB_HOST" ]; then
    echo -e "${YELLOW}Fetching DocumentDB endpoint from SSM Parameter Store...${NC}"
    DOCUMENTDB_HOST=$(aws ssm get-parameter \
        --name "/mcp-gateway/documentdb/endpoint" \
        --query 'Parameter.Value' \
        --output text \
        --region "$AWS_REGION" 2>/dev/null || echo "")

    if [ -n "$DOCUMENTDB_HOST" ]; then
        echo -e "${GREEN}Found DocumentDB endpoint in SSM${NC}"
    fi
fi

# Validate DocumentDB host
if [ -z "$DOCUMENTDB_HOST" ]; then
    echo -e "${RED}Error: DocumentDB endpoint not found${NC}"
    echo ""
    echo "Set DOCUMENTDB_HOST environment variable or ensure SSM parameter exists:"
    echo "  /mcp-gateway/documentdb/endpoint"
    exit 1
fi

# Get credentials from Secrets Manager
echo -e "${YELLOW}Fetching DocumentDB credentials from Secrets Manager...${NC}"
SECRET_ARN=$(aws secretsmanager list-secrets \
    --filters Key=name,Values=mcp-gateway/documentdb/credentials \
    --query 'SecretList[0].ARN' \
    --output text \
    --region "$AWS_REGION" 2>/dev/null || echo "")

DOCUMENTDB_USERNAME=""
DOCUMENTDB_PASSWORD=""

if [ -n "$SECRET_ARN" ] && [ "$SECRET_ARN" != "None" ]; then
    SECRET_JSON=$(aws secretsmanager get-secret-value \
        --secret-id "$SECRET_ARN" \
        --query 'SecretString' \
        --output text \
        --region "$AWS_REGION" 2>/dev/null || echo "")

    if [ -n "$SECRET_JSON" ]; then
        DOCUMENTDB_USERNAME=$(echo "$SECRET_JSON" | jq -r '.username // ""')
        DOCUMENTDB_PASSWORD=$(echo "$SECRET_JSON" | jq -r '.password // ""')
        echo -e "${GREEN}Found credentials in Secrets Manager${NC}"
    fi
fi

# Get VPC configuration from registry service
echo -e "${YELLOW}Getting VPC configuration from registry service...${NC}"
VPC_CONFIG=$(aws ecs describe-services \
    --cluster "$CLUSTER_NAME" \
    --services mcp-gateway-v2-registry \
    --region "$AWS_REGION" \
    --query 'services[0].networkConfiguration.awsvpcConfiguration' \
    --output json)

SUBNETS=$(echo "$VPC_CONFIG" | jq -r '.subnets | join(",")')
SECURITY_GROUPS=$(echo "$VPC_CONFIG" | jq -r '.securityGroups | join(",")')

echo -e "${BLUE}Configuration:${NC}"
echo "  Cluster: $CLUSTER_NAME"
echo "  Task: $TASK_FAMILY"
echo "  DocumentDB Host: $DOCUMENTDB_HOST"
echo "  DocumentDB Username: ${DOCUMENTDB_USERNAME:-<not set>}"
echo "  Command: $COMMAND"
echo ""

# Check if task definition exists
TASK_DEF_ARN=$(aws ecs describe-task-definition \
    --task-definition "$TASK_FAMILY" \
    --region "$AWS_REGION" \
    --query 'taskDefinition.taskDefinitionArn' \
    --output text 2>/dev/null || echo "")

if [ -z "$TASK_DEF_ARN" ] || [ "$TASK_DEF_ARN" = "None" ]; then
    echo -e "${RED}Error: Task definition '$TASK_FAMILY' not found${NC}"
    echo ""
    echo "You need to create the task definition first."
    echo "Run: cd terraform/aws-ecs && terraform apply"
    exit 1
fi

echo -e "${GREEN}Task definition found: $TASK_DEF_ARN${NC}"
echo ""

# Create command to run Python script
DOCKER_COMMAND="source /app/.venv/bin/activate && cd /app/scripts && python manage-documentdb.py $PYTHON_ARGS"

# Run the ECS task
echo -e "${YELLOW}Starting ECS task...${NC}"
TASK_ARN=$(aws ecs run-task \
    --cluster "$CLUSTER_NAME" \
    --task-definition "$TASK_FAMILY" \
    --launch-type FARGATE \
    --network-configuration "awsvpcConfiguration={subnets=[$SUBNETS],securityGroups=[$SECURITY_GROUPS],assignPublicIp=DISABLED}" \
    --overrides "$(jq -n \
        --arg container "$CONTAINER_NAME" \
        --arg cmd "$DOCKER_COMMAND" \
        --arg host "$DOCUMENTDB_HOST" \
        --arg user "$DOCUMENTDB_USERNAME" \
        --arg pass "$DOCUMENTDB_PASSWORD" \
        '{
            "containerOverrides": [{
                "name": $container,
                "command": ["/bin/bash", "-c", $cmd],
                "environment": [
                    {"name": "RUN_INIT_SCRIPTS", "value": "true"},
                    {"name": "DOCUMENTDB_HOST", "value": $host},
                    {"name": "DOCUMENTDB_PORT", "value": "27017"},
                    {"name": "DOCUMENTDB_USERNAME", "value": $user},
                    {"name": "DOCUMENTDB_PASSWORD", "value": $pass},
                    {"name": "DOCUMENTDB_DATABASE", "value": "mcp_registry"},
                    {"name": "DOCUMENTDB_USE_TLS", "value": "true"},
                    {"name": "DOCUMENTDB_USE_IAM", "value": "false"},
                    {"name": "DOCUMENTDB_TLS_CA_FILE", "value": "/app/certs/global-bundle.pem"}
                ]
            }]
        }')" \
    --region "$AWS_REGION" \
    --query 'tasks[0].taskArn' \
    --output text)

if [ -z "$TASK_ARN" ] || [ "$TASK_ARN" = "None" ]; then
    echo -e "${RED}Failed to start ECS task${NC}"
    exit 1
fi

TASK_ID=$(basename "$TASK_ARN")
echo -e "${GREEN}Task started: $TASK_ID${NC}"
echo ""

# Wait for task to complete
echo -e "${YELLOW}Waiting for task to complete...${NC}"
for i in {1..60}; do
    sleep 2

    STATUS=$(aws ecs describe-tasks \
        --cluster "$CLUSTER_NAME" \
        --tasks "$TASK_ARN" \
        --region "$AWS_REGION" \
        --query 'tasks[0].lastStatus' \
        --output text)

    if [ "$STATUS" = "STOPPED" ]; then
        echo -e "${GREEN}Task completed${NC}"
        break
    fi

    echo "  [$i] Status: $STATUS"
done

# Get exit code
EXIT_CODE=$(aws ecs describe-tasks \
    --cluster "$CLUSTER_NAME" \
    --tasks "$TASK_ARN" \
    --region "$AWS_REGION" \
    --query 'tasks[0].containers[0].exitCode' \
    --output text)

echo ""
echo -e "${BLUE}Task exit code: $EXIT_CODE${NC}"

# Get logs (wait a bit for logs to be available)
echo ""
echo -e "${YELLOW}Retrieving task logs...${NC}"
sleep 3

# Get the actual log stream name
LOG_STREAM_NAME="ecs/registry/$TASK_ID"

echo ""
printf '=%.0s' {1..100}
echo ""

# Try to get logs
LOGS=$(aws logs get-log-events \
    --log-group-name "/ecs/mcp-gateway-v2-registry" \
    --log-stream-name "$LOG_STREAM_NAME" \
    --region "$AWS_REGION" \
    --query 'events[*].message' \
    --output json 2>/dev/null)

if [ $? -eq 0 ] && [ -n "$LOGS" ] && [ "$LOGS" != "[]" ]; then
    # Parse JSON array and print each message on a new line
    echo "$LOGS" | jq -r '.[]' 2>/dev/null || echo "$LOGS"
else
    echo "No logs found in stream: $LOG_STREAM_NAME"
    echo ""
    echo "Available log streams:"
    aws logs describe-log-streams \
        --log-group-name "/ecs/mcp-gateway-v2-registry" \
        --order-by LastEventTime \
        --descending \
        --max-items 5 \
        --region "$AWS_REGION" \
        --query 'logStreams[*].logStreamName' \
        --output text 2>/dev/null || echo "Could not retrieve log streams"
fi

echo ""
printf '=%.0s' {1..100}
echo ""

# Exit with same code as task
if [ "$EXIT_CODE" = "0" ]; then
    echo -e "${GREEN}SUCCESS: Command completed${NC}"
else
    echo -e "${RED}ERROR: Command failed${NC}"
fi

exit "${EXIT_CODE:-1}"
