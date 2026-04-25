# MCP Gateway Registry - CDK Infrastructure

*Last Updated: 2026-04-25*

## Overview

The CDK infrastructure deploys the MCP Gateway Registry as a production-grade, multi-stack AWS deployment. It mirrors the existing Terraform deployment in `terraform/aws-ecs/` and provides an alternative IaC path using AWS CDK (TypeScript).

## Stack Architecture

The deployment is organized into **7 stacks** with explicit dependency ordering:

```
Registry-Network          (no dependencies)
    |
Registry-Data             (depends: Network)
    |
    +-- Registry-Auth     (depends: Network, Data)
    |       |
    |       +-- Registry-Service  (depends: Network, Data, Auth)
    |
    +-- Registry-Ops      (depends: Network, Data)
    |
Registry-Cdn              (depends: Service, Auth)
Registry-Build            (independent)
```

### Deployment Order

```bash
cdk deploy Registry-Network Registry-Data Registry-Auth Registry-Service Registry-Ops Registry-Cdn Registry-Build
```

Or deploy all:

```bash
cdk deploy --all
```

---

## Stack Details

### 1. Registry-Network

**File:** `lib/registry/registry-network-stack.ts`
**Purpose:** VPC, subnets, NAT gateways, and VPC endpoints.

| Resource | Type | Details |
|----------|------|---------|
| VPC | `ec2.Vpc` | CIDR from config (default `10.0.0.0/16`), 3 AZs |
| Private Subnets | `/20` | One per AZ, for ECS tasks and databases |
| Public Subnets | `/24` | One per AZ, for ALBs and NAT gateways |
| NAT Gateways | 3 | One per AZ for HA egress |
| VPC Endpoints | 2 | STS (interface), S3 (gateway) |
| Security Group | `ec2.SecurityGroup` | For VPC endpoints |

**Exports:** `vpc`, `privateSubnets`, `publicSubnets`, `vpcEndpointsSg`

---

### 2. Registry-Data

**File:** `lib/registry/registry-data-stack.ts`
**Purpose:** DocumentDB, Aurora MySQL (Keycloak), RDS Proxy, encryption keys, and database credentials.

| Resource | Type | Details |
|----------|------|---------|
| DocumentDB Cluster | Instance-based | Configurable shards (1-32), instance class, replica count |
| DocumentDB KMS Key | `kms.Key` | Auto-rotation, 7-day deletion window |
| DocumentDB Credentials | `secretsmanager.Secret` | Username/password stored as JSON |
| Aurora MySQL Cluster | Serverless v2 | For Keycloak, 0.5-2 ACUs |
| RDS Proxy | `rds.DatabaseProxy` | Connection pooling for Keycloak DB |
| RDS KMS Key | `kms.Key` | Separate from DocumentDB key |
| SSM Parameters | `ssm.StringParameter` | Connection strings, endpoints |

**Exports:** `documentDbCluster`, `documentDbSg`, `documentDbKmsKey`, `documentDbSecretArn`, `keycloakDbCluster`, `keycloakDbProxy`, `keycloakDbSecret`, `keycloakDbSg`, `rdsKmsKey`

---

### 3. Registry-Auth

**File:** `lib/registry/registry-auth-stack.ts`
**Construct:** `lib/registry/constructs/keycloak-service.ts`
**Purpose:** Keycloak identity provider deployment.

| Resource | Type | Details |
|----------|------|---------|
| Keycloak ECS Cluster | Separate cluster | Isolated from registry cluster |
| ECR Repository | `ecr.Repository` | Lifecycle policies for image cleanup |
| Fargate Task Definition | 1024 CPU / 2048 MiB | Keycloak container |
| ALB | Internet-facing | HTTP (80) + HTTPS (443) listeners |
| Route53 Records | Conditional | Only when `enableRoute53Dns: true` |
| ACM Certificate | Conditional | Cross-region (us-east-1) for CloudFront |
| Auto-scaling | 1-10 replicas | CPU/memory target tracking |
| SSM Parameters | Admin credentials | Keycloak admin user/password reference |

**Keycloak URL Resolution:**
- When `enableRoute53Dns: true` and domain configured: `https://{keycloak-domain}`
- Fallback: `http://{alb-dns-name}`

**Exports:** `keycloakUrl`, `keycloakAlbDns`, `keycloakAlbArn`, `keycloakAlbSg`, `keycloakEcsSg`, `keycloakEcsCluster`, `keycloakEcrRepo`, `keycloakDomain`

---

### 4. Registry-Service (Core Stack)

**File:** `lib/registry/registry-service-stack.ts`
**Purpose:** The main stack containing ECS cluster, ALB, EFS, secrets, and all application services.

#### 4.1 ECS Cluster and Service Discovery

| Resource | Type | Details |
|----------|------|---------|
| ECS Cluster | `ecs.Cluster` | Fargate capacity provider |
| Cloud Map Namespace | `servicediscovery.PrivateDnsNamespace` | `{name}.local` for Service Connect |

#### 4.2 Application Load Balancer

| Listener | Port | Protocol | Target |
|----------|------|----------|--------|
| HTTP | 80 | HTTP | Registry (8080) |
| HTTPS | 443 | HTTPS | Registry (8080), conditional on certificate |
| Auth | 8888 | HTTP/HTTPS | Auth Server (8888) |
| Gradio | 7860 | HTTP | Gradio UI (7860) |

- Internet-facing, deployed across all public subnets
- Access logs stored in S3 bucket with TLS enforcement and auto-deletion
- Ingress controlled by `ingressCidrBlocks` config array

#### 4.3 EFS File System

6 access points configured (POSIX user 1000:1000, permissions 755):

| Access Point | Path | Mounted By |
|--------------|------|------------|
| servers | /servers | Auth Server |
| models | /models | Auth Server |
| logs | /logs | Auth Server |
| agents | /agents | Auth Server |
| auth_config | /auth_config | Auth Server |
| mcpgw_data | /mcpgw_data | MCPGW MCP Server |

**Note:** The Registry service does NOT mount any EFS volumes. It uses ephemeral storage and DocumentDB for persistence. This matches the Terraform design (`mountPoints = []` in `ecs-services.tf`).

#### 4.4 Secrets Manager

Application secrets encrypted with a dedicated KMS key (auto-rotation enabled):

| Secret | Condition |
|--------|-----------|
| secret-key | Always |
| keycloak-client-secret | Always |
| keycloak-m2m-client-secret | Always |
| keycloak-admin-password | Always |
| embeddings-api-key | Always |
| entra-client-secret | When Entra ID provider enabled |
| okta-client-secret | When Okta provider enabled |
| okta-m2m-client-secret | When Okta provider enabled |
| okta-api-token | When Okta provider enabled |
| auth0-client-secret | When Auth0 provider enabled |
| auth0-m2m-client-secret | When Auth0 provider enabled |
| metrics-api-key | When observability enabled |
| otlp-exporter-headers | When observability + OTLP endpoint configured |

#### 4.5 Core ECS Services

| Service | Port | CPU/Memory | EFS Mounts | Service Connect |
|---------|------|------------|------------|-----------------|
| **Registry** | 8080 + 7860 | 1024/2048 | None | `registry` |
| **Auth Server** | 8888 | 512/1024 | servers, models, logs, agents, auth_config | `auth-server` |

**Registry Service - Key Configuration:**
- `HOME=/tmp` (required for `Path.home()` in container)
- DocumentDB credentials always passed when `dataStack.documentDbSecretArn` exists (regardless of `storageBackend` setting, because the skills repository always uses DocumentDB)
- Circuit breaker enabled (`circuitBreaker: { enable: true, rollback: true }`) - reduces failure detection from ~3 hours to ~4 minutes
- Two target groups: Registry (8080) and Gradio (7860)

#### 4.6 Optional MCP Server / A2A Agent Services

Created only when corresponding image URI is non-empty in config:

| Service | Port | CPU/Memory | Purpose |
|---------|------|------------|---------|
| CurrentTime MCP | 8000 | 512/1024 | Demo MCP server |
| MCPGW MCP | 8003 | 512/1024 | MCP gateway server |
| RealServerFakeTools MCP | 8002 | 512/1024 | Demo MCP server |
| Flight Booking Agent | 9000 | 512/1024 | A2A agent |
| Travel Assistant Agent | 9000 | 512/1024 | A2A agent |

#### 4.7 Observability Pipeline (Optional)

**Construct:** `lib/registry/constructs/observability-pipeline.ts`
**Condition:** `enableObservability: true`

| Resource | Type | Details |
|----------|------|---------|
| AMP Workspace | `aps.CfnWorkspace` | Amazon Managed Prometheus |
| Metrics Service | ECS Fargate | ADOT sidecar collector |
| Grafana OSS | ECS Fargate | ALB path-based routing (`/grafana`) |

**Exports:** `ecsCluster`, `registryEcsSg`, `authEcsSg`, `efsId`, `registryAlbDns`, `registryAlbArn`, `registryAlbSg`, `serviceDiscoveryNamespaceArn`, `appSecretsKmsKey`, `registryUrl`

---

### 5. Registry-Ops

**File:** `lib/registry/registry-ops-stack.ts`
**Construct:** `lib/registry/constructs/secret-rotation.ts`
**Purpose:** Automated secret rotation for database credentials.

| Resource | Type | Details |
|----------|------|---------|
| DocumentDB Rotation Lambda | `lambda.Function` | Rotates DocumentDB credentials |
| RDS Rotation Lambda | `lambda.Function` | Rotates Keycloak DB credentials |
| Rotation Schedule | 30-day cycle | Automatic rotation via Secrets Manager |
| Lambda Security Group | Egress rules | DocumentDB (27017), RDS (3306), HTTPS (443) |
| IAM Role | Rotation permissions | Secrets Manager, KMS, RDS, DocumentDB, VPC |

**Exports:** `rotationLambdaSg`

---

### 6. Registry-Cdn

**File:** `lib/registry/registry-cdn-stack.ts`
**Constructs:** `cloudfront-distribution.ts`, `waf-rules.ts`
**Purpose:** CloudFront CDN and WAF protection.

| Resource | Condition | Details |
|----------|-----------|---------|
| MCP Gateway CloudFront | `cloudfront.enabled: true` | Origin: Registry ALB |
| Keycloak CloudFront | `cloudfront.enabled: true` | Origin: Keycloak ALB |
| WAFv2 Web ACLs | `enableWaf: true` | Rate limiting, SQLi/XSS protection, IP reputation |
| ACM Certificates | CloudFront enabled | Cross-region (us-east-1) |
| Route53 Records | CloudFront + Route53 enabled | ALIAS records for distributions |

---

### 7. Registry-Build

**File:** `lib/registry/registry-build-stack.ts`
**Construct:** `lib/registry/constructs/codebuild-pipeline.ts`
**Purpose:** Container image registry and CI/CD pipeline.
**Condition:** `createCodebuild: true`

| Resource | Type | Details |
|----------|------|---------|
| ECR Repositories | 10 total | One per service image |
| CodeBuild Project | `codebuild.Project` | Build and push container images |
| S3 Artifacts Bucket | `s3.Bucket` | Build artifacts storage |

**ECR Repositories:**
`mcp-gateway/registry`, `mcp-gateway/auth-server`, `mcp-gateway/keycloak`, `mcp-gateway/currenttime`, `mcp-gateway/mcpgw`, `mcp-gateway/realserverfaketools`, `mcp-gateway/flight-booking-agent`, `mcp-gateway/travel-assistant-agent`, `mcp-gateway/metrics-service`, `mcp-gateway/grafana`

---

## Reusable Constructs (L3)

All constructs are in `lib/registry/constructs/`:

| Construct | File | Purpose |
|-----------|------|---------|
| `RegistryEcsService` | `registry-ecs-service.ts` | Standardized ECS Fargate service with Service Connect, ALB targets, EFS, auto-scaling, circuit breaker |
| `KeycloakService` | `keycloak-service.ts` | Complete Keycloak deployment (cluster, task, ALB, DNS, certs) |
| `DocumentDbCluster` | `documentdb-cluster.ts` | Instance-based DocumentDB with KMS encryption |
| `McpServerService` | `mcp-server-service.ts` | Optional MCP/Agent service (no-op if image URI empty) |
| `ObservabilityPipeline` | `observability-pipeline.ts` | AMP + Metrics + Grafana stack (no-op if disabled) |
| `CloudFrontDistribution` | `cloudfront-distribution.ts` | CloudFront with cross-region ACM |
| `WafRules` | `waf-rules.ts` | WAFv2 Web ACLs |
| `SecretRotation` | `secret-rotation.ts` | Lambda-based secret rotation |
| `CodeBuildPipeline` | `codebuild-pipeline.ts` | ECR + CodeBuild |

---

## Configuration

### Configuration File

**Path:** `infra/config.yaml`

Configuration is loaded with a 3-tier merge strategy:
1. `DEFAULT_REGISTRY_CONFIG` (hardcoded defaults in `registry-config.ts`)
2. YAML file values (`config.yaml`)
3. Environment variable overrides (`CDK_*` prefix)

### Key Configuration Options

```yaml
registry:
  enabled: true
  name: mcp-gateway
  awsRegion: us-east-1

  # Network
  vpcCidr: "10.0.0.0/16"
  ingressCidrBlocks: ["0.0.0.0/0"]

  # DNS (optional)
  enableRoute53Dns: false
  useRegionalDomains: true
  baseDomain: mycorp.click
  certificateArn: ""

  # Storage
  storageBackend: file            # 'file' or 'documentdb'

  # Deployment
  deploymentMode: with-gateway    # 'with-gateway' or 'registry-only'
  registryMode: full              # 'full', 'skills-only', 'mcp-servers-only', 'agents-only'
  enableObservability: true
  enableWaf: false
  createCodebuild: false

  # DocumentDB
  documentdb:
    shardCapacity: 2
    shardCount: 1
    instanceClass: db.t3.medium
    replicaCount: 0

  # Container images
  images:
    registry: ""
    authServer: ""
    keycloak: ""
    currenttime: ""
    mcpgw: ""
    realserverfaketools: ""
    flightBookingAgent: ""
    travelAssistantAgent: ""

  # Replicas
  replicas:
    registry: 1
    authServer: 1
    keycloak: 1

  # Identity providers (multi-provider support)
  entra: { enabled: false }
  okta: { enabled: false }
  auth0: { enabled: false }

  # Optional features
  cloudfront: { enabled: false }
  federation: { enabled: false }
  embeddings: { provider: "sentence-transformers" }
```

### Environment Variables (Secrets)

Sensitive values are passed via environment variables, never committed to config files:

| Variable | Purpose |
|----------|---------|
| `CDK_KEYCLOAK_ADMIN_PASSWORD` | Keycloak admin credentials |
| `CDK_KEYCLOAK_DATABASE_PASSWORD` | Aurora MySQL password |
| `CDK_DOCUMENTDB_ADMIN_PASSWORD` | DocumentDB credentials |
| `CDK_EMBEDDINGS_API_KEY` | Embeddings provider API key |
| `CDK_ENTRA_CLIENT_SECRET` | Microsoft Entra ID client secret |
| `CDK_OKTA_CLIENT_SECRET` | Okta client secret |
| `CDK_OKTA_M2M_CLIENT_SECRET` | Okta M2M client secret |
| `CDK_OKTA_API_TOKEN` | Okta API token |
| `CDK_AUTH0_CLIENT_SECRET` | Auth0 client secret |
| `CDK_AUTH0_M2M_CLIENT_SECRET` | Auth0 M2M client secret |
| `CDK_REGISTRY_API_TOKEN` | Static token auth |
| `CDK_FEDERATION_STATIC_TOKEN` | Federation peer auth |
| `CDK_FEDERATION_ENCRYPTION_KEY` | Federation encryption |
| `CDK_GITHUB_PAT` | GitHub personal access token |
| `CDK_GITHUB_APP_PRIVATE_KEY` | GitHub App private key |
| `CDK_GRAFANA_ADMIN_PASSWORD` | Grafana admin password |
| `CDK_OTEL_EXPORTER_OTLP_HEADERS` | OTLP export headers |

---

## Cross-Stack Security Groups

Security group ingress rules are added by downstream stacks using `CfnSecurityGroupIngress` (L1 constructs) to avoid circular cross-stack references:

| Source SG | Target SG | Port | Added By |
|-----------|-----------|------|----------|
| Registry ECS | DocumentDB | 27017 | Service Stack |
| Auth Server ECS | DocumentDB | 27017 | Service Stack |
| Registry ECS | Keycloak ALB | 443 | Service Stack |
| Auth Server ECS | Keycloak ALB | 443 | Service Stack |
| Rotation Lambda | DocumentDB | 27017 | Ops Stack |
| Rotation Lambda | Keycloak DB | 3306 | Ops Stack |
| VPC CIDR | EFS | 2049 | Service Stack |

---

## CDK vs Terraform Parity

### Intentional CDK Differences

These are deliberate improvements in the CDK deployment:

| Feature | CDK | Terraform | Rationale |
|---------|-----|-----------|-----------|
| Circuit Breaker | Enabled on all ECS services | Not configured | Reduces failed deployment detection from ~3 hours to ~4 minutes |
| `HOME=/tmp` | Set on registry container | Not set | Fixes `Path.home()` PermissionError in container |
| DocumentDB Credentials | Always passed when cluster exists | Gated on `storage_backend == "documentdb"` | Skills repository always uses DocumentDB regardless of storage backend setting |
| Keycloak URL Fallback | Falls back to `http://{alb-dns}` | Always uses `https://` | Allows deployment without Route53/certificates |

### Parity Areas

| Area | Status | Notes |
|------|--------|-------|
| VPC/Networking | Matched | Same CIDR, AZs, subnet layout, VPC endpoints |
| DocumentDB | Matched | Instance-based cluster, same encryption/auth config |
| Aurora MySQL | Matched | Serverless v2 for Keycloak |
| ECS Services | Matched | Same CPU/memory, ports, service discovery |
| EFS | Matched | Same 6 access points, same POSIX config |
| Registry EFS Mounts | Matched | Both have `mountPoints = []` (no EFS on registry) |
| ALB | Matched | Same listener ports, target groups, access logging |
| Secrets Manager | Matched | Same secrets, same conditional creation |
| CloudFront/WAF | Matched | Same distribution setup and WAF rules |
| Observability | Matched | Same AMP + Grafana + ADOT pipeline |

---

## File Structure

```
infra/
+-- bin/
|   +-- main.ts                          # CDK app entry point
+-- lib/registry/
|   +-- registry-config.ts               # Configuration interfaces and loading
|   +-- registry-network-stack.ts        # Stack 1: VPC, subnets, NAT, endpoints
|   +-- registry-data-stack.ts           # Stack 2: DocumentDB, Aurora, RDS Proxy
|   +-- registry-auth-stack.ts           # Stack 3: Keycloak ECS service
|   +-- registry-service-stack.ts        # Stack 4: Core services, ALB, EFS, secrets
|   +-- registry-ops-stack.ts            # Stack 5: Secret rotation Lambdas
|   +-- registry-cdn-stack.ts            # Stack 6: CloudFront + WAF
|   +-- registry-build-stack.ts          # Stack 7: ECR + CodeBuild
|   +-- constructs/
|       +-- registry-ecs-service.ts      # L3: Reusable ECS Fargate service
|       +-- keycloak-service.ts          # L3: Complete Keycloak deployment
|       +-- documentdb-cluster.ts        # L3: DocumentDB with encryption
|       +-- mcp-server-service.ts        # L3: Optional MCP/Agent service
|       +-- observability-pipeline.ts    # L3: AMP + Metrics + Grafana
|       +-- cloudfront-distribution.ts   # L3: CloudFront with ACM
|       +-- waf-rules.ts                 # L3: WAFv2 Web ACLs
|       +-- secret-rotation.ts           # L3: Lambda secret rotation
|       +-- codebuild-pipeline.ts        # L3: ECR + CodeBuild
+-- config.yaml                          # Default configuration
+-- cdk.json                             # CDK configuration
+-- package.json                         # Dependencies (aws-cdk-lib ^2.170.0)
+-- tsconfig.json                        # TypeScript configuration
+-- docs/
    +-- CDK-INFRASTRUCTURE.md            # This file
```

---

## Resource Summary

| Component | Count | Purpose |
|-----------|-------|---------|
| VPC | 1 | Network isolation |
| Subnets | 6 | 3 private + 3 public (multi-AZ) |
| NAT Gateways | 3 | HA outbound (one per AZ) |
| VPC Endpoints | 2 | STS, S3 |
| ECS Clusters | 2 | Registry + Keycloak |
| ALBs | 2 | Registry + Keycloak |
| EFS | 1 | 6 access points |
| DocumentDB | 1 | NoSQL storage |
| Aurora MySQL | 1 | Keycloak database |
| RDS Proxy | 1 | Connection pooling |
| KMS Keys | 2+ | DocumentDB, RDS, application secrets |
| Secrets Manager | 10+ | Database credentials, API keys, OAuth |
| Lambda Functions | 2 | Secret rotation (DocumentDB, RDS) |
| CloudFront | 0-2 | Optional CDN distributions |
| WAF Web ACLs | 0-2 | Optional threat protection |
| ECR Repositories | 10 | Container images |

---

## Development Commands

```bash
# Install dependencies
cd infra && npm install

# Compile TypeScript
npm run build

# Synthesize CloudFormation templates
npx cdk synth

# Show changes before deploying
npx cdk diff
```

---

## Deployment

### Prerequisites

1. AWS credentials configured with sufficient permissions (Admin or equivalent)
2. Node.js and npm installed
3. CDK CLI available (`npx cdk` or globally installed)
4. Container images pushed to ECR (set URIs in `config.yaml` under `images:`)

### Export Required Secrets

All sensitive values must be set as environment variables before deploying. Never put these in `config.yaml`.

```bash
# Required for all deployments
export CDK_KEYCLOAK_ADMIN_PASSWORD="<your-password>"
export CDK_KEYCLOAK_DATABASE_PASSWORD="<your-password>"
export CDK_DOCUMENTDB_ADMIN_PASSWORD="<your-password>"

# Required if using embeddings API
export CDK_EMBEDDINGS_API_KEY="<your-key>"

# Optional - identity providers (set only the ones you use)
export CDK_ENTRA_CLIENT_SECRET="<secret>"          # Microsoft Entra ID
export CDK_OKTA_CLIENT_SECRET="<secret>"            # Okta
export CDK_OKTA_M2M_CLIENT_SECRET="<secret>"        # Okta M2M
export CDK_OKTA_API_TOKEN="<token>"                 # Okta API
export CDK_AUTH0_CLIENT_SECRET="<secret>"            # Auth0
export CDK_AUTH0_M2M_CLIENT_SECRET="<secret>"        # Auth0 M2M

# Optional - federation
export CDK_REGISTRY_API_TOKEN="<token>"             # Static token auth
export CDK_FEDERATION_STATIC_TOKEN="<token>"        # Federation peer auth
export CDK_FEDERATION_ENCRYPTION_KEY="<key>"        # Federation encryption

# Optional - GitHub integration
export CDK_GITHUB_PAT="<pat>"                       # GitHub personal access token
export CDK_GITHUB_APP_PRIVATE_KEY="<key>"           # GitHub App private key

# Optional - observability
export CDK_GRAFANA_ADMIN_PASSWORD="<password>"      # Grafana admin
export CDK_OTEL_EXPORTER_OTLP_HEADERS="<headers>"  # OTLP export headers
```

### Deploy All Stacks

CDK resolves the dependency order automatically.

```bash
cd infra
npm run build
npx cdk synth
npx cdk deploy --all --region us-east-1 --require-approval never
```

Estimated time: ~20-40 minutes (DocumentDB and Aurora cluster creation take the longest).

### Deploy Stacks Individually (Recommended for First Deployment)

Deploy in dependency order to watch progress and catch failures early:

```bash
cd infra
npm run build

# Stack 1: VPC, subnets, NAT gateways (~3-5 min)
npx cdk deploy Registry-Network --region us-east-1 --require-approval never

# Stack 2: DocumentDB, Aurora MySQL, RDS Proxy (~10-15 min)
npx cdk deploy Registry-Data --region us-east-1 --require-approval never

# Stack 3: Keycloak ECS service (~5-8 min)
npx cdk deploy Registry-Auth --region us-east-1 --require-approval never

# Stack 4: Core services, ALB, EFS, secrets (~5-10 min)
npx cdk deploy Registry-Service --region us-east-1 --require-approval never

# Stack 5: Secret rotation Lambdas (~2-3 min)
npx cdk deploy Registry-Ops --region us-east-1 --require-approval never

# Stack 6: CloudFront + WAF (~3-5 min, skipped if cloudfront.enabled: false)
npx cdk deploy Registry-Cdn --region us-east-1 --require-approval never

# Stack 7: ECR + CodeBuild (~2-3 min, skipped if createCodebuild: false)
npx cdk deploy Registry-Build --region us-east-1 --require-approval never
```

### Destroy All Stacks

CDK handles reverse dependency order automatically.

```bash
cd infra
npx cdk destroy --all --region us-east-1
```

Estimated time: ~15-25 minutes. You will be prompted for confirmation.

### Destroy and Redeploy (Full Reset)

Use when you need a clean slate (e.g., after a failed deployment left stacks in a bad state).

```bash
cd infra

# Step 1: Destroy all stacks (~15-25 min)
npx cdk destroy --all --region us-east-1

# Step 2: Verify all stacks are gone
aws cloudformation list-stacks --region us-east-1 \
  --query 'StackSummaries[?starts_with(StackName, `Registry-`) && StackStatus != `DELETE_COMPLETE`].{Name:StackName,Status:StackStatus}' \
  --output table

# Step 3: Export secrets (see "Export Required Secrets" above)

# Step 4: Build and redeploy
npm run build
npx cdk deploy --all --region us-east-1 --require-approval never
```

### Check Stack Status

```bash
# List all Registry stacks and their status
aws cloudformation list-stacks --region us-east-1 \
  --query 'StackSummaries[?starts_with(StackName, `Registry-`) && StackStatus != `DELETE_COMPLETE`].{Name:StackName,Status:StackStatus}' \
  --output table

# Watch a specific stack's events in real time
aws cloudformation describe-stack-events --region us-east-1 \
  --stack-name Registry-Service \
  --query 'StackEvents[0:10].{Time:Timestamp,Status:ResourceStatus,Type:ResourceType,Reason:ResourceStatusReason}' \
  --output table

# Check ECS service logs after deployment
aws logs tail /ecs/mcp-gateway-registry --region us-east-1 --since 10m --follow
```

---

## Troubleshooting

### Common Deployment Failures

**ECS Deployment Circuit Breaker Triggered**
- Symptom: `ECS Deployment Circuit Breaker was triggered` in CloudFormation events
- Check: CloudWatch logs in `/ecs/mcp-gateway-registry` log group
- Common causes: container crash on startup, database connectivity, missing secrets

**DocumentDB Authorization Failure**
- Symptom: `pymongo.errors.OperationFailure: Authorization failure, code: 13`
- Cause: DocumentDB credentials not passed to container
- Fix: Ensure `dataStack.documentDbSecretArn` is set (credentials are always passed when the cluster exists)

**Path.home() PermissionError**
- Symptom: `PermissionError: Permission denied: '/home/appuser'`
- Cause: Container user's home directory doesn't exist or isn't writable
- Fix: `HOME=/tmp` environment variable on the registry container

**3-Hour CloudFormation Timeout**
- Symptom: Stack stuck in `CREATE_IN_PROGRESS` for hours
- Cause: Missing circuit breaker on ECS service, CloudFormation waits for stabilization timeout
- Fix: Circuit breaker is now enabled on all services via `RegistryEcsService` construct
