/**
 * RegistryServiceStack - Core ECS services, ALB, EFS, and Secrets Manager.
 *
 * Translates the following Terraform resources into CDK:
 *   - modules/mcp-gateway/networking.tf   (Service Discovery, ALB, SGs)
 *   - modules/mcp-gateway/storage.tf      (EFS + access points)
 *   - modules/mcp-gateway/secrets.tf      (KMS + Secrets Manager)
 *   - modules/mcp-gateway/iam.tf          (IAM policies)
 *   - modules/mcp-gateway/ecs-services.tf (Registry, Auth, MCP servers, A2A agents)
 *   - alb-logging.tf                      (ALB access logs S3 bucket)
 *
 * Depends on: RegistryNetworkStack, RegistryDataStack, RegistryAuthStack.
 */

import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as efs from 'aws-cdk-lib/aws-efs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as servicediscovery from 'aws-cdk-lib/aws-servicediscovery';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

import { RegistryConfig } from './registry-config';
import { RegistryNetworkStack } from './registry-network-stack';
import { RegistryDataStack } from './registry-data-stack';
import { RegistryAuthStack } from './registry-auth-stack';
import { RegistryEcsService } from './constructs/registry-ecs-service';
import { McpServerService } from './constructs/mcp-server-service';
import { ObservabilityPipeline } from './constructs/observability-pipeline';

// ---------------------------------------------------------------------------
// Stack props
// ---------------------------------------------------------------------------

export interface RegistryServiceStackProps extends cdk.StackProps {
  readonly config: RegistryConfig;
  readonly networkStack: RegistryNetworkStack;
  readonly dataStack: RegistryDataStack;
  readonly authStack: RegistryAuthStack;
}

// ---------------------------------------------------------------------------
// Stack
// ---------------------------------------------------------------------------

export class RegistryServiceStack extends cdk.Stack {
  /** ECS cluster running all registry services */
  public readonly ecsCluster: ecs.Cluster;

  /** Security group for registry ECS tasks */
  public readonly registryEcsSg: ec2.SecurityGroup;

  /** Security group for auth server ECS tasks */
  public readonly authEcsSg: ec2.SecurityGroup;

  /** EFS file system ID */
  public readonly efsId: string;

  /** DNS name of the registry ALB */
  public readonly registryAlbDns: string;

  /** ARN of the registry ALB */
  public readonly registryAlbArn: string;

  /** Security group attached to the registry ALB */
  public readonly registryAlbSg: ec2.SecurityGroup;

  /** Cloud Map namespace ARN */
  public readonly serviceDiscoveryNamespaceArn: string;

  /** KMS key for application secrets */
  public readonly appSecretsKmsKey: kms.Key;

  /** Full URL for the registry */
  public readonly registryUrl: string;

  constructor(scope: Construct, id: string, props: RegistryServiceStackProps) {
    super(scope, id, props);

    const { config, networkStack, dataStack, authStack } = props;
    const { vpc, privateSubnets, publicSubnets } = networkStack;
    const region = this.region;
    const accountId = this.account;
    const namePrefix = config.name;

    // Computed domain
    const registryDomain = config.useRegionalDomains
      ? `${region}.${config.baseDomain}`
      : config.baseDomain;

    this.registryUrl = config.enableRoute53Dns || config.certificateArn !== ''
      ? `https://${registryDomain}`
      : ''; // Will be set to ALB DNS after ALB creation

    // ==================================================================
    // Section 1: Service Discovery
    // ==================================================================

    const cloudMapNamespace = new servicediscovery.PrivateDnsNamespace(
      this, 'CloudMapNamespace', {
        name: `${namePrefix}.local`,
        description: 'Service discovery namespace for MCP Gateway Registry',
        vpc,
      },
    );

    this.serviceDiscoveryNamespaceArn = cloudMapNamespace.namespaceArn;

    // ==================================================================
    // Section 2: ECS Cluster
    // ==================================================================

    this.ecsCluster = new ecs.Cluster(this, 'EcsCluster', {
      clusterName: `${namePrefix}-ecs-cluster`,
      vpc,
      containerInsights: true,
    });

    const cfnCluster = this.ecsCluster.node.defaultChild as ecs.CfnCluster;
    cfnCluster.capacityProviders = ['FARGATE'];
    cfnCluster.defaultCapacityProviderStrategy = [
      { capacityProvider: 'FARGATE', base: 1, weight: 50 },
    ];
    cfnCluster.addPropertyOverride('ServiceConnectDefaults', {
      Namespace: cloudMapNamespace.namespaceArn,
    });

    // ==================================================================
    // Section 3: ALB Access Logs S3 Bucket
    // ==================================================================

    const albLogsBucket = new s3.Bucket(this, 'AlbLogsBucket', {
      bucketName: `${namePrefix}-${region}-${accountId}-alb-logs`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      versioned: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      lifecycleRules: [
        {
          id: 'delete-old-logs',
          enabled: true,
          expiration: cdk.Duration.days(90),
        },
      ],
    });

    // Bucket policy: enforce TLS + allow ELB log delivery
    albLogsBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'EnforceTLS',
        effect: iam.Effect.DENY,
        principals: [new iam.AnyPrincipal()],
        actions: ['s3:*'],
        resources: [albLogsBucket.bucketArn, `${albLogsBucket.bucketArn}/*`],
        conditions: {
          Bool: { 'aws:SecureTransport': 'false' },
        },
      }),
    );

    albLogsBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AWSLogDeliveryWrite',
        effect: iam.Effect.ALLOW,
        principals: [
          new iam.ServicePrincipal('logdelivery.elasticloadbalancing.amazonaws.com'),
        ],
        actions: ['s3:PutObject'],
        resources: [`${albLogsBucket.bucketArn}/*`],
        conditions: {
          StringEquals: { 's3:x-amz-acl': 'bucket-owner-full-control' },
        },
      }),
    );

    albLogsBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AWSLogDeliveryAclCheck',
        effect: iam.Effect.ALLOW,
        principals: [
          new iam.ServicePrincipal('logdelivery.elasticloadbalancing.amazonaws.com'),
        ],
        actions: ['s3:GetBucketAcl'],
        resources: [albLogsBucket.bucketArn],
      }),
    );

    // ==================================================================
    // Section 4: ALB + Security Groups + Listeners + Target Groups
    // ==================================================================

    // --- ALB security group ---

    this.registryAlbSg = new ec2.SecurityGroup(this, 'AlbSg', {
      vpc,
      securityGroupName: `${namePrefix}-alb`,
      description: 'Security group for MCP Gateway Registry ALB',
      allowAllOutbound: true,
    });

    cdk.Tags.of(this.registryAlbSg).add('Name', `${namePrefix}-alb`);

    // Dynamic CIDR ingress for ports 80, 443, 8888, 7860
    const albPorts = [80, 443, 8888, 7860];
    for (const cidr of config.ingressCidrBlocks) {
      for (const port of albPorts) {
        this.registryAlbSg.addIngressRule(
          ec2.Peer.ipv4(cidr),
          ec2.Port.tcp(port),
          `Ingress from ${cidr} to port ${port}`,
        );
      }
    }

    // --- ALB ---

    const isInternal = false; // Terraform var.alb_scheme default is internet-facing
    const alb = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      loadBalancerName: `${namePrefix}-alb`,
      vpc,
      internetFacing: !isInternal,
      vpcSubnets: { subnets: isInternal ? privateSubnets : publicSubnets },
      securityGroup: this.registryAlbSg,
      dropInvalidHeaderFields: true,
      deletionProtection: false,
    });

    // Enable access logging
    alb.logAccessLogs(albLogsBucket);

    this.registryAlbDns = alb.loadBalancerDnsName;
    this.registryAlbArn = alb.loadBalancerArn;

    // Update registryUrl if no custom domain
    if (this.registryUrl === '') {
      this.registryUrl = `http://${alb.loadBalancerDnsName}`;
    }

    // --- Target Groups ---

    const registryTg = new elbv2.ApplicationTargetGroup(this, 'RegistryTg', {
      targetGroupName: `${namePrefix}-registry-tg`,
      port: 8080,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      vpc,
      deregistrationDelay: cdk.Duration.seconds(5),
      healthCheck: {
        enabled: true,
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 2,
        timeout: cdk.Duration.seconds(5),
        interval: cdk.Duration.seconds(30),
        path: '/health',
        port: '8080',
        healthyHttpCodes: '200',
        protocol: elbv2.Protocol.HTTP,
      },
    });

    const authTg = new elbv2.ApplicationTargetGroup(this, 'AuthTg', {
      targetGroupName: `${namePrefix}-auth-tg`,
      port: 8888,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      vpc,
      deregistrationDelay: cdk.Duration.seconds(5),
      healthCheck: {
        enabled: true,
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 2,
        timeout: cdk.Duration.seconds(5),
        interval: cdk.Duration.seconds(30),
        path: '/health',
        healthyHttpCodes: '200',
        protocol: elbv2.Protocol.HTTP,
      },
    });

    const gradioTg = new elbv2.ApplicationTargetGroup(this, 'GradioTg', {
      targetGroupName: `${namePrefix}-gradio-tg`,
      port: 7860,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      vpc,
      deregistrationDelay: cdk.Duration.seconds(5),
      healthCheck: {
        enabled: true,
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 2,
        timeout: cdk.Duration.seconds(5),
        interval: cdk.Duration.seconds(30),
        path: '/health',
        healthyHttpCodes: '200',
        protocol: elbv2.Protocol.HTTP,
      },
    });

    // --- Listeners ---

    // HTTP listener (port 80) -> registry target group
    const httpListener = alb.addListener('HttpListener', {
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      defaultTargetGroups: [registryTg],
    });

    // HTTPS listener (port 443) - conditional on certificate
    const enableHttps = config.certificateArn !== '';
    let httpsListener: elbv2.ApplicationListener | undefined;
    if (enableHttps) {
      httpsListener = alb.addListener('HttpsListener', {
        port: 443,
        protocol: elbv2.ApplicationProtocol.HTTPS,
        sslPolicy: elbv2.SslPolicy.TLS13_RES,
        certificates: [
          elbv2.ListenerCertificate.fromArn(config.certificateArn),
        ],
        defaultTargetGroups: [registryTg],
      });
    }

    // Auth listener (port 8888)
    alb.addListener('AuthListener', {
      port: 8888,
      protocol: enableHttps ? elbv2.ApplicationProtocol.HTTPS : elbv2.ApplicationProtocol.HTTP,
      ...(enableHttps
        ? {
          sslPolicy: elbv2.SslPolicy.TLS13_RES,
          certificates: [
            elbv2.ListenerCertificate.fromArn(config.certificateArn),
          ],
        }
        : {}),
      defaultTargetGroups: [authTg],
    });

    // Gradio listener (port 7860)
    alb.addListener('GradioListener', {
      port: 7860,
      protocol: elbv2.ApplicationProtocol.HTTP,
      defaultTargetGroups: [gradioTg],
    });

    // ==================================================================
    // Section 5: EFS File System + Access Points
    // ==================================================================

    const fileSystem = new efs.FileSystem(this, 'Efs', {
      fileSystemName: `${namePrefix}-efs`,
      vpc,
      vpcSubnets: { subnets: privateSubnets },
      encrypted: true,
      performanceMode: efs.PerformanceMode.GENERAL_PURPOSE,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.efsId = fileSystem.fileSystemId;

    // EFS security group: allow NFS 2049 from VPC CIDR
    const efsSg = new ec2.SecurityGroup(this, 'EfsSg', {
      vpc,
      securityGroupName: `${namePrefix}-efs`,
      description: 'Security group for EFS mount targets',
      allowAllOutbound: true,
    });

    efsSg.addIngressRule(
      ec2.Peer.ipv4(config.vpcCidr),
      ec2.Port.tcp(2049),
      'NFS from VPC',
    );

    // Allow traffic from the custom efsSg to the EFS default SG
    fileSystem.connections.allowFrom(efsSg, ec2.Port.tcp(2049));

    // Allow ECS tasks in private subnets to mount EFS.
    // The EFS L2 creates its own default SG on mount targets; add an ingress
    // rule from the VPC CIDR so any task in the VPC can reach port 2049.
    fileSystem.connections.allowFrom(
      ec2.Peer.ipv4(config.vpcCidr),
      ec2.Port.tcp(2049),
      'NFS from VPC CIDR (ECS tasks)',
    );

    // Access points (all UID/GID 1000, permissions 755)
    const accessPointConfigs: Array<{ key: string; path: string }> = [
      { key: 'servers', path: '/servers' },
      { key: 'models', path: '/models' },
      { key: 'logs', path: '/logs' },
      { key: 'agents', path: '/agents' },
      { key: 'authConfig', path: '/auth_config' },
      { key: 'mcpgwData', path: '/mcpgw_data' },
    ];

    const accessPoints: Record<string, efs.AccessPoint> = {};
    for (const ap of accessPointConfigs) {
      accessPoints[ap.key] = new efs.AccessPoint(this, `Ap${_capitalize(ap.key)}`, {
        fileSystem,
        path: ap.path,
        posixUser: { uid: '1000', gid: '1000' },
        createAcl: { ownerUid: '1000', ownerGid: '1000', permissions: '755' },
      });

      cdk.Tags.of(accessPoints[ap.key]).add('Name', `${namePrefix} ${ap.key}`);
    }

    // ==================================================================
    // Section 6: KMS Key + Secrets Manager
    // ==================================================================

    this.appSecretsKmsKey = new kms.Key(this, 'SecretsKmsKey', {
      description: 'KMS key for MCP Gateway application secrets encryption',
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      pendingWindow: cdk.Duration.days(7),
    });

    // Key policy: allow ECS task execution roles to decrypt
    this.appSecretsKmsKey.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowEcsTaskExecDecrypt',
        effect: iam.Effect.ALLOW,
        principals: [new iam.AnyPrincipal()],
        actions: ['kms:Decrypt', 'kms:DescribeKey'],
        resources: ['*'],
        conditions: {
          StringEquals: { 'aws:PrincipalAccount': accountId },
          StringLike: {
            'aws:PrincipalArn': `arn:aws:iam::${accountId}:role/*task-exec*`,
          },
        },
      }),
    );

    // Key policy: allow CloudWatch Logs
    this.appSecretsKmsKey.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowCloudWatchLogs',
        effect: iam.Effect.ALLOW,
        principals: [new iam.ServicePrincipal(`logs.${region}.amazonaws.com`)],
        actions: [
          'kms:Encrypt',
          'kms:Decrypt',
          'kms:ReEncrypt*',
          'kms:GenerateDataKey*',
          'kms:CreateGrant',
          'kms:DescribeKey',
        ],
        resources: ['*'],
        conditions: {
          ArnLike: {
            'kms:EncryptionContext:aws:logs:arn':
              `arn:aws:logs:${region}:${accountId}:log-group:*`,
          },
        },
      }),
    );

    new kms.Alias(this, 'SecretsKmsAlias', {
      aliasName: `alias/${namePrefix}-secrets`,
      targetKey: this.appSecretsKmsKey,
    });

    // --- Secrets Manager secrets ---

    // secret_key (random 64-char value)
    const secretKeySecret = _createSecret(this, 'SecretKey', {
      namePrefix: `${namePrefix}-secret-key-`,
      description: 'Secret key for MCP Gateway Registry',
      kmsKey: this.appSecretsKmsKey,
      generateString: { passwordLength: 64, excludePunctuation: false },
    });

    // keycloak_client_secret (placeholder, updated by init-keycloak.sh)
    const keycloakClientSecret = _createSecret(this, 'KeycloakClientSecret', {
      fixedName: 'mcp-gateway-keycloak-client-secret',
      description: 'Keycloak web client secret (updated by init-keycloak.sh after deployment)',
      kmsKey: this.appSecretsKmsKey,
      secretStringValue: JSON.stringify({
        client_secret: 'placeholder-will-be-updated-by-init-script',
      }),
    });

    // keycloak_m2m_client_secret
    const keycloakM2mClientSecret = _createSecret(this, 'KeycloakM2mClientSecret', {
      fixedName: 'mcp-gateway-keycloak-m2m-client-secret',
      description: 'Keycloak M2M client secret (updated by init-keycloak.sh after deployment)',
      kmsKey: this.appSecretsKmsKey,
      secretStringValue: JSON.stringify({
        client_secret: 'placeholder-will-be-updated-by-init-script',
      }),
    });

    // keycloak_admin_password
    const keycloakAdminPasswordSecret = _createSecret(this, 'KeycloakAdminPassword', {
      namePrefix: `${namePrefix}-keycloak-admin-password-`,
      description: 'Keycloak admin password for Management API user/group operations',
      kmsKey: this.appSecretsKmsKey,
      secretStringValue: config.keycloak.adminPassword,
    });

    // embeddings_api_key
    const embeddingsApiKeySecret = _createSecret(this, 'EmbeddingsApiKey', {
      namePrefix: `${namePrefix}-embeddings-api-key-`,
      description: 'API key for embeddings provider (OpenAI, Anthropic, etc.)',
      kmsKey: this.appSecretsKmsKey,
      secretStringValue: config.embeddings.apiKey !== '' ? config.embeddings.apiKey : 'not-configured',
    });

    // entra_client_secret (conditional)
    let entraClientSecret: secretsmanager.Secret | undefined;
    if (config.entra.enabled) {
      entraClientSecret = _createSecret(this, 'EntraClientSecret', {
        namePrefix: `${namePrefix}-entra-client-secret-`,
        description: 'Microsoft Entra ID client secret for OAuth authentication and IAM operations',
        kmsKey: this.appSecretsKmsKey,
        secretStringValue: config.entra.clientSecret,
      });
    }

    // okta secrets (conditional)
    let oktaClientSecret: secretsmanager.Secret | undefined;
    let oktaM2mClientSecret: secretsmanager.Secret | undefined;
    let oktaApiTokenSecret: secretsmanager.Secret | undefined;
    if (config.okta.enabled) {
      oktaClientSecret = _createSecret(this, 'OktaClientSecret', {
        namePrefix: `${namePrefix}-okta-client-secret-`,
        description: 'Okta client secret for OAuth authentication',
        kmsKey: this.appSecretsKmsKey,
        secretStringValue: config.okta.clientSecret,
      });

      oktaM2mClientSecret = _createSecret(this, 'OktaM2mClientSecret', {
        namePrefix: `${namePrefix}-okta-m2m-client-secret-`,
        description: 'Okta M2M client secret for service account operations',
        kmsKey: this.appSecretsKmsKey,
        secretStringValue: config.okta.m2mClientSecret,
      });

      oktaApiTokenSecret = _createSecret(this, 'OktaApiToken', {
        namePrefix: `${namePrefix}-okta-api-token-`,
        description: 'Okta API token for IAM management operations',
        kmsKey: this.appSecretsKmsKey,
        secretStringValue: config.okta.apiToken,
      });
    }

    // auth0 secrets (conditional)
    let auth0ClientSecret: secretsmanager.Secret | undefined;
    let auth0M2mClientSecret: secretsmanager.Secret | undefined;
    if (config.auth0.enabled) {
      auth0ClientSecret = _createSecret(this, 'Auth0ClientSecret', {
        namePrefix: `${namePrefix}-auth0-client-secret-`,
        description: 'Auth0 client secret for OAuth authentication',
        kmsKey: this.appSecretsKmsKey,
        secretStringValue: config.auth0.clientSecret,
      });

      auth0M2mClientSecret = _createSecret(this, 'Auth0M2mClientSecret', {
        namePrefix: `${namePrefix}-auth0-m2m-client-secret-`,
        description: 'Auth0 M2M client secret for IAM Management operations',
        kmsKey: this.appSecretsKmsKey,
        secretStringValue: config.auth0.m2mClientSecret,
      });
    }

    // metrics_api_key (conditional on observability)
    let metricsApiKeySecret: secretsmanager.Secret | undefined;
    if (config.enableObservability) {
      metricsApiKeySecret = _createSecret(this, 'MetricsApiKey', {
        namePrefix: `${namePrefix}-metrics-api-key-`,
        description: 'API key for metrics-service (shared by auth-server and registry)',
        kmsKey: this.appSecretsKmsKey,
        generateString: { passwordLength: 48, excludePunctuation: true },
      });
    }

    // otlp_exporter_headers (conditional)
    let otlpExporterHeadersSecret: secretsmanager.Secret | undefined;
    if (config.enableObservability && config.otel.otlpEndpoint !== '') {
      otlpExporterHeadersSecret = _createSecret(this, 'OtlpExporterHeaders', {
        namePrefix: `${namePrefix}-otlp-exporter-headers-`,
        description: 'OTLP exporter authentication headers (e.g., Datadog API key)',
        kmsKey: this.appSecretsKmsKey,
        secretStringValue: config.otel.exporterOtlpHeaders,
      });
    }

    // --- Build list of all secret ARNs for IAM policy ---

    const allSecretArns: string[] = [
      secretKeySecret.secretArn,
      keycloakClientSecret.secretArn,
      keycloakM2mClientSecret.secretArn,
      keycloakAdminPasswordSecret.secretArn,
      embeddingsApiKeySecret.secretArn,
    ];

    if (dataStack.documentDbSecretArn) {
      allSecretArns.push(dataStack.documentDbSecretArn);
    }
    if (entraClientSecret) allSecretArns.push(entraClientSecret.secretArn);
    if (oktaClientSecret) allSecretArns.push(oktaClientSecret.secretArn);
    if (oktaM2mClientSecret) allSecretArns.push(oktaM2mClientSecret.secretArn);
    if (oktaApiTokenSecret) allSecretArns.push(oktaApiTokenSecret.secretArn);
    if (auth0ClientSecret) allSecretArns.push(auth0ClientSecret.secretArn);
    if (auth0M2mClientSecret) allSecretArns.push(auth0M2mClientSecret.secretArn);
    if (metricsApiKeySecret) allSecretArns.push(metricsApiKeySecret.secretArn);
    if (otlpExporterHeadersSecret) allSecretArns.push(otlpExporterHeadersSecret.secretArn);

    // IAM statements for Secrets Manager + KMS access
    const secretsAccessStatements: iam.PolicyStatement[] = [
      new iam.PolicyStatement({
        sid: 'SecretsManagerAccess',
        effect: iam.Effect.ALLOW,
        actions: ['secretsmanager:GetSecretValue'],
        resources: allSecretArns,
      }),
      new iam.PolicyStatement({
        sid: 'KmsDecrypt',
        effect: iam.Effect.ALLOW,
        actions: ['kms:Decrypt', 'kms:DescribeKey'],
        resources: [this.appSecretsKmsKey.keyArn],
      }),
    ];

    // ==================================================================
    // Section 7: Auth provider determination
    // ==================================================================

    const authProvider = config.auth0.enabled
      ? 'auth0'
      : config.okta.enabled
        ? 'okta'
        : config.entra.enabled
          ? 'entra'
          : authStack.keycloakDomain !== ''
            ? 'keycloak'
            : 'default';

    // ==================================================================
    // Section 8: Registry ECS Service
    // ==================================================================

    // Build environment variables for the registry container
    const registryEnv: Record<string, string> = {
      HOME: '/tmp',
      REGISTRY_URL: this.registryUrl,
      GATEWAY_ADDITIONAL_SERVER_NAMES: registryDomain,
      EC2_PUBLIC_DNS: registryDomain || alb.loadBalancerDnsName,
      AUTH_SERVER_URL: 'http://auth-server:8888',
      AUTH_SERVER_EXTERNAL_URL: this.registryUrl,
      KEYCLOAK_URL: authStack.keycloakUrl,
      KEYCLOAK_ENABLED: authStack.keycloakDomain !== '' ? 'true' : 'false',
      KEYCLOAK_REALM: 'mcp-gateway',
      KEYCLOAK_CLIENT_ID: 'mcp-gateway-web',
      AUTH_PROVIDER: authProvider,
      ENTRA_ENABLED: String(config.entra.enabled),
      ENTRA_TENANT_ID: config.entra.tenantId,
      ENTRA_CLIENT_ID: config.entra.clientId,
      IDP_GROUP_FILTER_PREFIX: config.idpGroupFilterPrefix,
      OKTA_ENABLED: String(config.okta.enabled),
      OKTA_DOMAIN: config.okta.domain,
      OKTA_CLIENT_ID: config.okta.clientId,
      OKTA_M2M_CLIENT_ID: config.okta.m2mClientId,
      OKTA_AUTH_SERVER_ID: config.okta.authServerId,
      AUTH0_ENABLED: String(config.auth0.enabled),
      AUTH0_DOMAIN: config.auth0.domain,
      AUTH0_CLIENT_ID: config.auth0.clientId,
      AUTH0_AUDIENCE: config.auth0.audience,
      AUTH0_GROUPS_CLAIM: config.auth0.groupsClaim,
      AUTH0_M2M_CLIENT_ID: config.auth0.m2mClientId,
      AUTH0_MANAGEMENT_API_TOKEN: config.auth0.managementApiToken,
      AWS_REGION: config.awsRegion,
      SCOPES_CONFIG_PATH: '/app/auth_server/scopes.yml',
      EMBEDDINGS_PROVIDER: config.embeddings.provider,
      EMBEDDINGS_MODEL_NAME: config.embeddings.modelName,
      EMBEDDINGS_MODEL_DIMENSIONS: String(config.embeddings.modelDimensions),
      EMBEDDINGS_AWS_REGION: config.embeddings.awsRegion,
      SESSION_COOKIE_SECURE: String(config.session.cookieSecure),
      SESSION_COOKIE_DOMAIN: config.session.cookieDomain,
      SECURITY_SCAN_ENABLED: String(config.security.scanEnabled),
      SECURITY_SCAN_ON_REGISTRATION: String(config.security.scanOnRegistration),
      SECURITY_BLOCK_UNSAFE_SERVERS: String(config.security.blockUnsafeServers),
      SECURITY_ANALYZERS: config.security.analyzers,
      SECURITY_SCAN_TIMEOUT: String(config.security.scanTimeout),
      SECURITY_ADD_PENDING_TAG: String(config.security.addPendingTag),
      KEYCLOAK_ADMIN: 'admin',
      STORAGE_BACKEND: config.storageBackend,
      DOCUMENTDB_HOST: _getDocumentDbEndpoint(dataStack),
      DOCUMENTDB_PORT: '27017',
      DOCUMENTDB_DATABASE: config.documentdb.database,
      DOCUMENTDB_NAMESPACE: config.documentdb.namespace,
      DOCUMENTDB_USE_TLS: String(config.documentdb.useTls),
      DOCUMENTDB_USE_IAM: String(config.documentdb.useIam),
      DOCUMENTDB_TLS_CA_FILE: '/app/certs/global-bundle.pem',
      REGISTRY_ID: config.federation.registryId,
      REGISTRY_NAME: config.registryCard.name,
      REGISTRY_ORGANIZATION_NAME: config.registryCard.organizationName,
      REGISTRY_DESCRIPTION: config.registryCard.description,
      REGISTRY_CONTACT_EMAIL: config.registryCard.contactEmail,
      REGISTRY_CONTACT_URL: config.registryCard.contactUrl,
      FEDERATION_STATIC_TOKEN_AUTH_ENABLED: String(config.federation.staticTokenAuthEnabled),
      FEDERATION_STATIC_TOKEN: config.federation.staticToken,
      FEDERATION_ENCRYPTION_KEY: config.federation.encryptionKey,
      AWS_REGISTRY_FEDERATION_ENABLED: String(config.federation.awsRegistryFederationEnabled),
      ANS_INTEGRATION_ENABLED: String(config.ans.integrationEnabled),
      ANS_API_ENDPOINT: config.ans.apiEndpoint,
      ANS_API_KEY: config.ans.apiKey,
      ANS_API_SECRET: config.ans.apiSecret,
      ANS_API_TIMEOUT_SECONDS: String(config.ans.apiTimeoutSeconds),
      ANS_SYNC_INTERVAL_HOURS: String(config.ans.syncIntervalHours),
      ANS_VERIFICATION_CACHE_TTL_SECONDS: String(config.ans.verificationCacheTtlSeconds),
      AUDIT_LOG_ENABLED: String(config.audit.logEnabled),
      AUDIT_LOG_MONGODB_TTL_DAYS: String(config.audit.logTtlDays),
      DEPLOYMENT_MODE: config.deploymentMode,
      REGISTRY_MODE: config.registryMode,
      SHOW_SERVERS_TAB: String(config.uiTabs.showServersTab),
      SHOW_VIRTUAL_SERVERS_TAB: String(config.uiTabs.showVirtualServersTab),
      SHOW_SKILLS_TAB: String(config.uiTabs.showSkillsTab),
      SHOW_AGENTS_TAB: String(config.uiTabs.showAgentsTab),
      OAUTH_STORE_TOKENS_IN_SESSION: String(config.session.oauthStoreTokensInSession),
      REGISTRY_STATIC_TOKEN_AUTH_ENABLED: String(config.staticTokenAuth.registryStaticTokenAuthEnabled),
      REGISTRY_API_TOKEN: config.staticTokenAuth.registryApiToken,
      MAX_TOKENS_PER_USER_PER_HOUR: String(config.staticTokenAuth.maxTokensPerUserPerHour),
      M2M_DIRECT_REGISTRATION_ENABLED: String(config.staticTokenAuth.m2mDirectRegistrationEnabled),
      MCP_TELEMETRY_DISABLED: config.telemetry.disabled,
      MCP_TELEMETRY_OPT_OUT: config.telemetry.optOut,
      MCP_TELEMETRY_HEARTBEAT_INTERVAL_MINUTES: config.telemetry.heartbeatIntervalMinutes,
      TELEMETRY_DEBUG: config.telemetry.debug,
      DISABLE_AI_REGISTRY_TOOLS_SERVER: config.disableAiRegistryToolsServer,
      METRICS_SERVICE_URL: config.enableObservability ? 'http://metrics-service:8890' : '',
      SERVICE_CONNECT_NAMESPACE: `${namePrefix}.local`,
      GITHUB_PAT: config.github.pat,
      GITHUB_APP_ID: config.github.appId,
      GITHUB_APP_INSTALLATION_ID: config.github.appInstallationId,
      GITHUB_APP_PRIVATE_KEY: config.github.appPrivateKey,
      GITHUB_EXTRA_HOSTS: config.github.extraHosts,
      GITHUB_API_BASE_URL: config.github.apiBaseUrl,
    };

    // Build secrets for the registry container
    const registrySecrets: Record<string, ecs.Secret> = {
      SECRET_KEY: ecs.Secret.fromSecretsManager(secretKeySecret),
      KEYCLOAK_CLIENT_SECRET: ecs.Secret.fromSecretsManager(
        keycloakClientSecret, 'client_secret',
      ),
      KEYCLOAK_M2M_CLIENT_SECRET: ecs.Secret.fromSecretsManager(
        keycloakM2mClientSecret, 'client_secret',
      ),
      KEYCLOAK_ADMIN_PASSWORD: ecs.Secret.fromSecretsManager(keycloakAdminPasswordSecret),
      EMBEDDINGS_API_KEY: ecs.Secret.fromSecretsManager(embeddingsApiKeySecret),
    };

    // DocumentDB secrets — always pass when a cluster exists because the
    // skills repository uses DocumentDB regardless of storageBackend.
    if (dataStack.documentDbSecretArn) {
      const docdbSecret = secretsmanager.Secret.fromSecretCompleteArn(
        this, 'DocDbSecretRef', dataStack.documentDbSecretArn,
      );
      registrySecrets['DOCUMENTDB_USERNAME'] = ecs.Secret.fromSecretsManager(docdbSecret, 'username');
      registrySecrets['DOCUMENTDB_PASSWORD'] = ecs.Secret.fromSecretsManager(docdbSecret, 'password');
    }

    // Conditional IdP secrets
    if (entraClientSecret) {
      registrySecrets['ENTRA_CLIENT_SECRET'] = ecs.Secret.fromSecretsManager(entraClientSecret);
    }
    if (oktaClientSecret) {
      registrySecrets['OKTA_CLIENT_SECRET'] = ecs.Secret.fromSecretsManager(oktaClientSecret);
    }
    if (oktaM2mClientSecret) {
      registrySecrets['OKTA_M2M_CLIENT_SECRET'] = ecs.Secret.fromSecretsManager(oktaM2mClientSecret);
    }
    if (oktaApiTokenSecret) {
      registrySecrets['OKTA_API_TOKEN'] = ecs.Secret.fromSecretsManager(oktaApiTokenSecret);
    }
    if (auth0ClientSecret) {
      registrySecrets['AUTH0_CLIENT_SECRET'] = ecs.Secret.fromSecretsManager(auth0ClientSecret);
    }
    if (auth0M2mClientSecret) {
      registrySecrets['AUTH0_M2M_CLIENT_SECRET'] = ecs.Secret.fromSecretsManager(auth0M2mClientSecret);
    }
    if (metricsApiKeySecret) {
      registrySecrets['METRICS_API_KEY'] = ecs.Secret.fromSecretsManager(metricsApiKeySecret);
    }

    // Additional task role policies for registry
    const registryTaskRolePolicies: iam.IManagedPolicy[] = [];
    if (config.federation.awsRegistryFederationEnabled) {
      const agentCorePolicy = new iam.ManagedPolicy(this, 'BedrockAgentCorePolicy', {
        statements: [
          new iam.PolicyStatement({
            sid: 'BedrockAgentCoreFullAccess',
            effect: iam.Effect.ALLOW,
            actions: ['bedrock-agentcore:*'],
            resources: ['*'],
          }),
          new iam.PolicyStatement({
            sid: 'StsAssumeRoleForCrossAccount',
            effect: iam.Effect.ALLOW,
            actions: ['sts:AssumeRole'],
            resources: ['*'],
            conditions: {
              StringLike: {
                'iam:ResourceTag/Purpose': 'agentcore-federation',
              },
            },
          }),
        ],
      });
      registryTaskRolePolicies.push(agentCorePolicy);
    }

    const registryService = new RegistryEcsService(this, 'RegistrySvc', {
      serviceName: 'registry',
      image: config.images.registry,
      cpu: 1024,
      memory: 2048,
      containerPort: 8080,
      additionalPorts: [
        { port: 8443, name: 'https' },
        { port: 7860, name: 'registry' },
      ],
      vpc,
      subnets: privateSubnets,
      cluster: this.ecsCluster,
      serviceConnectNamespaceArn: cloudMapNamespace.namespaceArn,
      serviceConnect: {
        port: 8080,
        dnsName: 'registry',
        portName: 'http',
        discoveryName: 'registry',
      },
      environment: registryEnv,
      secrets: registrySecrets,
      targetGroups: [
        { targetGroup: registryTg, containerPort: 8080 },
        { targetGroup: gradioTg, containerPort: 7860 },
      ],
      additionalTaskRolePolicies: registryTaskRolePolicies,
      additionalExecRoleStatements: secretsAccessStatements,
      healthCheckCommand: 'curl -f http://localhost:7860/health || exit 1',
      namePrefix,
      desiredCount: config.replicas.registry,
    });

    this.registryEcsSg = registryService.securityGroup;

    // Registry SG ingress: ALB ports 8080, 8443, 7860
    registryService.securityGroup.addIngressRule(
      this.registryAlbSg,
      ec2.Port.tcp(8080),
      'HTTP port (non-root nginx) from ALB',
    );
    registryService.securityGroup.addIngressRule(
      this.registryAlbSg,
      ec2.Port.tcp(8443),
      'HTTPS port (non-root nginx) from ALB',
    );
    registryService.securityGroup.addIngressRule(
      this.registryAlbSg,
      ec2.Port.tcp(7860),
      'Gradio port from ALB',
    );

    // ==================================================================
    // Section 9: Auth Server ECS Service
    // ==================================================================

    const authEnv: Record<string, string> = {
      REGISTRY_URL: this.registryUrl,
      AUTH_SERVER_URL: 'http://auth-server:8888',
      AUTH_SERVER_EXTERNAL_URL: this.registryUrl,
      AWS_REGION: config.awsRegion,
      AUTH_PROVIDER: authProvider,
      KEYCLOAK_URL: authStack.keycloakUrl,
      KEYCLOAK_EXTERNAL_URL: authStack.keycloakUrl,
      KEYCLOAK_REALM: 'mcp-gateway',
      KEYCLOAK_CLIENT_ID: 'mcp-gateway-web',
      KEYCLOAK_M2M_CLIENT_ID: 'mcp-gateway-m2m',
      ENTRA_ENABLED: String(config.entra.enabled),
      ENTRA_TENANT_ID: config.entra.tenantId,
      ENTRA_CLIENT_ID: config.entra.clientId,
      IDP_GROUP_FILTER_PREFIX: config.idpGroupFilterPrefix,
      OKTA_ENABLED: String(config.okta.enabled),
      OKTA_DOMAIN: config.okta.domain,
      OKTA_CLIENT_ID: config.okta.clientId,
      OKTA_M2M_CLIENT_ID: config.okta.m2mClientId,
      OKTA_AUTH_SERVER_ID: config.okta.authServerId,
      AUTH0_DOMAIN: config.auth0.domain,
      AUTH0_CLIENT_ID: config.auth0.clientId,
      AUTH0_AUDIENCE: config.auth0.audience,
      AUTH0_GROUPS_CLAIM: config.auth0.groupsClaim,
      AUTH0_M2M_CLIENT_ID: config.auth0.m2mClientId,
      AUTH0_MANAGEMENT_API_TOKEN: config.auth0.managementApiToken,
      AUTH0_ENABLED: String(config.auth0.enabled),
      SCOPES_CONFIG_PATH: '/efs/auth_config/auth_config/scopes.yml',
      SESSION_COOKIE_SECURE: String(config.session.cookieSecure),
      SESSION_COOKIE_DOMAIN: config.session.cookieDomain,
      OAUTH_STORE_TOKENS_IN_SESSION: String(config.session.oauthStoreTokensInSession),
      REGISTRY_STATIC_TOKEN_AUTH_ENABLED: String(config.staticTokenAuth.registryStaticTokenAuthEnabled),
      REGISTRY_API_TOKEN: config.staticTokenAuth.registryApiToken,
      M2M_DIRECT_REGISTRATION_ENABLED: String(config.staticTokenAuth.m2mDirectRegistrationEnabled),
      REGISTRY_ID: config.federation.registryId,
      FEDERATION_STATIC_TOKEN_AUTH_ENABLED: String(config.federation.staticTokenAuthEnabled),
      FEDERATION_STATIC_TOKEN: config.federation.staticToken,
      FEDERATION_ENCRYPTION_KEY: config.federation.encryptionKey,
      ANS_INTEGRATION_ENABLED: String(config.ans.integrationEnabled),
      ANS_API_ENDPOINT: config.ans.apiEndpoint,
      ANS_API_KEY: config.ans.apiKey,
      ANS_API_SECRET: config.ans.apiSecret,
      ANS_API_TIMEOUT_SECONDS: String(config.ans.apiTimeoutSeconds),
      ANS_SYNC_INTERVAL_HOURS: String(config.ans.syncIntervalHours),
      ANS_VERIFICATION_CACHE_TTL_SECONDS: String(config.ans.verificationCacheTtlSeconds),
      STORAGE_BACKEND: config.storageBackend,
      DOCUMENTDB_HOST: _getDocumentDbEndpoint(dataStack),
      DOCUMENTDB_PORT: '27017',
      DOCUMENTDB_DATABASE: config.documentdb.database,
      DOCUMENTDB_NAMESPACE: config.documentdb.namespace,
      DOCUMENTDB_USE_TLS: String(config.documentdb.useTls),
      DOCUMENTDB_USE_IAM: String(config.documentdb.useIam),
      DOCUMENTDB_TLS_CA_FILE: '/app/certs/global-bundle.pem',
      AUDIT_LOG_ENABLED: String(config.audit.logEnabled),
      AUDIT_LOG_MONGODB_TTL_DAYS: String(config.audit.logTtlDays),
      METRICS_SERVICE_URL: config.enableObservability ? 'http://metrics-service:8890' : '',
    };

    // Auth server secrets
    const authSecrets: Record<string, ecs.Secret> = {
      SECRET_KEY: ecs.Secret.fromSecretsManager(secretKeySecret),
      KEYCLOAK_CLIENT_SECRET: ecs.Secret.fromSecretsManager(
        keycloakClientSecret, 'client_secret',
      ),
      KEYCLOAK_M2M_CLIENT_SECRET: ecs.Secret.fromSecretsManager(
        keycloakM2mClientSecret, 'client_secret',
      ),
    };

    if (dataStack.documentDbSecretArn) {
      const docdbSecretAuth = secretsmanager.Secret.fromSecretCompleteArn(
        this, 'DocDbSecretRefAuth', dataStack.documentDbSecretArn,
      );
      authSecrets['DOCUMENTDB_USERNAME'] = ecs.Secret.fromSecretsManager(docdbSecretAuth, 'username');
      authSecrets['DOCUMENTDB_PASSWORD'] = ecs.Secret.fromSecretsManager(docdbSecretAuth, 'password');
    }

    if (entraClientSecret) {
      authSecrets['ENTRA_CLIENT_SECRET'] = ecs.Secret.fromSecretsManager(entraClientSecret);
    }
    if (oktaClientSecret) {
      authSecrets['OKTA_CLIENT_SECRET'] = ecs.Secret.fromSecretsManager(oktaClientSecret);
    }
    if (oktaM2mClientSecret) {
      authSecrets['OKTA_M2M_CLIENT_SECRET'] = ecs.Secret.fromSecretsManager(oktaM2mClientSecret);
    }
    if (oktaApiTokenSecret) {
      authSecrets['OKTA_API_TOKEN'] = ecs.Secret.fromSecretsManager(oktaApiTokenSecret);
    }
    if (auth0ClientSecret) {
      authSecrets['AUTH0_CLIENT_SECRET'] = ecs.Secret.fromSecretsManager(auth0ClientSecret);
    }
    if (auth0M2mClientSecret) {
      authSecrets['AUTH0_M2M_CLIENT_SECRET'] = ecs.Secret.fromSecretsManager(auth0M2mClientSecret);
    }
    if (metricsApiKeySecret) {
      authSecrets['METRICS_API_KEY'] = ecs.Secret.fromSecretsManager(metricsApiKeySecret);
    }

    const authService = new RegistryEcsService(this, 'AuthSvc', {
      serviceName: 'auth-server',
      image: config.images.authServer,
      cpu: 512,
      memory: 1024,
      containerPort: 8888,
      vpc,
      subnets: privateSubnets,
      cluster: this.ecsCluster,
      serviceConnectNamespaceArn: cloudMapNamespace.namespaceArn,
      serviceConnect: {
        port: 8888,
        dnsName: 'auth-server',
        portName: 'auth-server',
        discoveryName: 'auth-server',
      },
      environment: authEnv,
      secrets: authSecrets,
      efsVolumes: [
        {
          volumeName: 'mcp-logs',
          fileSystemId: fileSystem.fileSystemId,
          accessPointId: accessPoints['logs'].accessPointId,
          containerPath: '/app/logs',
        },
        {
          volumeName: 'auth-config',
          fileSystemId: fileSystem.fileSystemId,
          accessPointId: accessPoints['authConfig'].accessPointId,
          containerPath: '/efs/auth_config',
        },
      ],
      targetGroups: [
        { targetGroup: authTg, containerPort: 8888 },
      ],
      additionalExecRoleStatements: secretsAccessStatements,
      healthCheckCommand: 'curl -f http://localhost:8888/health || exit 1',
      namePrefix,
      desiredCount: config.replicas.auth,
    });

    this.authEcsSg = authService.securityGroup;

    // Auth SG ingress: ALB port 8888, registry port 8888
    authService.securityGroup.addIngressRule(
      this.registryAlbSg,
      ec2.Port.tcp(8888),
      'Auth server port from ALB',
    );
    authService.securityGroup.addIngressRule(
      registryService.securityGroup,
      ec2.Port.tcp(8888),
      'Allow registry to access auth server',
    );

    // ==================================================================
    // Section 10: Optional MCP Server / Agent Services
    // ==================================================================

    // --- CurrentTime MCP Server ---
    const currenttimeService = new McpServerService(this, 'CurrenttimeSvc', {
      serviceName: 'currenttime-server',
      imageUri: config.images.currenttime,
      containerPort: 8000,
      vpc,
      subnets: privateSubnets,
      cluster: this.ecsCluster,
      serviceConnectNamespaceArn: cloudMapNamespace.namespaceArn,
      serviceConnectDnsName: 'currenttime-server',
      serviceConnectPortName: 'currenttime',
      environment: {
        PORT: '8000',
        MCP_TRANSPORT: 'streamable-http',
      },
      ingressSecurityGroup: registryService.securityGroup,
      namePrefix,
      desiredCount: config.replicas.currenttime,
    });

    // --- MCPGW MCP Server ---
    const mcpgwService = new McpServerService(this, 'McpgwSvc', {
      serviceName: 'mcpgw-server',
      imageUri: config.images.mcpgw,
      containerPort: 8003,
      vpc,
      subnets: privateSubnets,
      cluster: this.ecsCluster,
      serviceConnectNamespaceArn: cloudMapNamespace.namespaceArn,
      serviceConnectDnsName: 'mcpgw-server',
      serviceConnectPortName: 'mcpgw',
      environment: {
        PORT: '8003',
        REGISTRY_BASE_URL: 'http://registry:8080',
        REGISTRY_USERNAME: 'admin',
      },
      efsVolumes: [
        {
          volumeName: 'mcpgw-data',
          fileSystemId: fileSystem.fileSystemId,
          accessPointId: accessPoints['mcpgwData'].accessPointId,
          containerPath: '/app/data',
        },
      ],
      ingressSecurityGroup: registryService.securityGroup,
      additionalExecRoleStatements: secretsAccessStatements,
      namePrefix,
      desiredCount: config.replicas.mcpgw,
    });

    // MCPGW -> Registry ingress on ports 8080 and 7860
    if (mcpgwService.securityGroup) {
      registryService.securityGroup.addIngressRule(
        mcpgwService.securityGroup,
        ec2.Port.tcp(8080),
        'HTTP from mcpgw for internal API calls (non-root nginx)',
      );
      registryService.securityGroup.addIngressRule(
        mcpgwService.securityGroup,
        ec2.Port.tcp(7860),
        'Allow mcpgw to access registry API',
      );
    }

    // --- RealServerFakeTools MCP Server ---
    new McpServerService(this, 'RealServerFakeToolsSvc', {
      serviceName: 'realserverfaketools-server',
      imageUri: config.images.realserverfaketools,
      containerPort: 8002,
      vpc,
      subnets: privateSubnets,
      cluster: this.ecsCluster,
      serviceConnectNamespaceArn: cloudMapNamespace.namespaceArn,
      serviceConnectDnsName: 'realserverfaketools-server',
      serviceConnectPortName: 'realserverfaketools',
      environment: {
        PORT: '8002',
        MCP_TRANSPORT: 'streamable-http',
      },
      ingressSecurityGroup: registryService.securityGroup,
      namePrefix,
      desiredCount: config.replicas.realserverfaketools,
    });

    // --- Flight Booking A2A Agent ---
    new McpServerService(this, 'FlightBookingSvc', {
      serviceName: 'flight-booking-agent',
      imageUri: config.images.flightBookingAgent,
      containerPort: 9000,
      vpc,
      subnets: privateSubnets,
      cluster: this.ecsCluster,
      serviceConnectNamespaceArn: cloudMapNamespace.namespaceArn,
      serviceConnectDnsName: 'flight-booking-agent',
      serviceConnectPortName: 'flight-booking',
      environment: {
        AWS_REGION: config.awsRegion,
        AWS_DEFAULT_REGION: config.awsRegion,
      },
      ingressCidr: config.vpcCidr,
      healthCheckCommand: 'curl -f http://localhost:9000/ping || exit 1',
      namePrefix,
      desiredCount: config.replicas.flightBookingAgent,
    });

    // --- Travel Assistant A2A Agent ---
    new McpServerService(this, 'TravelAssistantSvc', {
      serviceName: 'travel-assistant-agent',
      imageUri: config.images.travelAssistantAgent,
      containerPort: 9000,
      vpc,
      subnets: privateSubnets,
      cluster: this.ecsCluster,
      serviceConnectNamespaceArn: cloudMapNamespace.namespaceArn,
      serviceConnectDnsName: 'travel-assistant-agent',
      serviceConnectPortName: 'travel-assistant',
      environment: {
        AWS_REGION: config.awsRegion,
        AWS_DEFAULT_REGION: config.awsRegion,
      },
      ingressCidr: config.vpcCidr,
      healthCheckCommand: 'curl -f http://localhost:9000/ping || exit 1',
      namePrefix,
      desiredCount: config.replicas.travelAssistantAgent,
    });

    // ==================================================================
    // Section 11: Cross-Stack Security Group Mutations
    // ==================================================================

    // Uses CfnSecurityGroupIngress to avoid cross-stack cyclic dependency
    // (Service depends on Data/Auth, so their SG objects cannot reference Service SG)

    // DocumentDB SG ingress from registry + auth ECS SGs (port 27017)
    new ec2.CfnSecurityGroupIngress(this, 'DocDbFromRegistry', {
      groupId: dataStack.documentDbSg.securityGroupId,
      ipProtocol: 'tcp',
      fromPort: 27017,
      toPort: 27017,
      sourceSecurityGroupId: registryService.securityGroup.securityGroupId,
      description: 'DocumentDB ingress from registry ECS tasks',
    });

    new ec2.CfnSecurityGroupIngress(this, 'DocDbFromAuth', {
      groupId: dataStack.documentDbSg.securityGroupId,
      ipProtocol: 'tcp',
      fromPort: 27017,
      toPort: 27017,
      sourceSecurityGroupId: authService.securityGroup.securityGroupId,
      description: 'DocumentDB ingress from auth server ECS tasks',
    });

    // Keycloak ALB SG ingress from registry + auth ECS SGs (port 443 for HTTPS, port 80 for HTTP)
    new ec2.CfnSecurityGroupIngress(this, 'KeycloakAlbFromRegistry', {
      groupId: authStack.keycloakAlbSg.securityGroupId,
      ipProtocol: 'tcp',
      fromPort: 443,
      toPort: 443,
      sourceSecurityGroupId: registryService.securityGroup.securityGroupId,
      description: 'Keycloak ALB ingress from registry ECS tasks (HTTPS)',
    });

    new ec2.CfnSecurityGroupIngress(this, 'KeycloakAlbFromAuthSvc', {
      groupId: authStack.keycloakAlbSg.securityGroupId,
      ipProtocol: 'tcp',
      fromPort: 443,
      toPort: 443,
      sourceSecurityGroupId: authService.securityGroup.securityGroupId,
      description: 'Keycloak ALB ingress from auth server ECS tasks (HTTPS)',
    });

    new ec2.CfnSecurityGroupIngress(this, 'KeycloakAlbHttpFromRegistry', {
      groupId: authStack.keycloakAlbSg.securityGroupId,
      ipProtocol: 'tcp',
      fromPort: 80,
      toPort: 80,
      sourceSecurityGroupId: registryService.securityGroup.securityGroupId,
      description: 'Keycloak ALB ingress from registry ECS tasks (HTTP)',
    });

    new ec2.CfnSecurityGroupIngress(this, 'KeycloakAlbHttpFromAuthSvc', {
      groupId: authStack.keycloakAlbSg.securityGroupId,
      ipProtocol: 'tcp',
      fromPort: 80,
      toPort: 80,
      sourceSecurityGroupId: authService.securityGroup.securityGroupId,
      description: 'Keycloak ALB ingress from auth server ECS tasks (HTTP)',
    });

    // ==================================================================
    // Section 12: Observability (AMP + Grafana + ADOT)
    // ==================================================================

    new ObservabilityPipeline(this, 'Observability', {
      config,
      vpc,
      privateSubnets,
      ecsCluster: this.ecsCluster,
      serviceConnectNamespaceArn: cloudMapNamespace.namespaceArn,
      alb,
      httpListener,
      httpsListener,
      appSecretsKmsKey: this.appSecretsKmsKey,
      metricsApiKeySecret,
      otlpExporterHeadersSecret,
      secretsAccessStatements,
      registryServiceSg: registryService.securityGroup,
      authServiceSg: authService.securityGroup,
      albSg: this.registryAlbSg,
      namePrefix,
    });

    // ==================================================================
    // Section 13: Tags
    // ==================================================================

    cdk.Tags.of(this).add('Project', 'mcp-gateway-registry');
    cdk.Tags.of(this).add('Component', 'service');
    cdk.Tags.of(this).add('Environment', 'production');
    cdk.Tags.of(this).add('ManagedBy', 'cdk');

    // ==================================================================
    // Section 14: Stack Outputs
    // ==================================================================

    new cdk.CfnOutput(this, 'RegistryUrl', {
      value: this.registryUrl,
      description: 'MCP Gateway Registry URL',
    });

    new cdk.CfnOutput(this, 'RegistryAlbDnsName', {
      value: this.registryAlbDns,
      description: 'Registry ALB DNS name',
    });

    new cdk.CfnOutput(this, 'KeycloakUrl', {
      value: authStack.keycloakUrl,
      description: 'Keycloak identity provider URL',
    });

    new cdk.CfnOutput(this, 'GradioUiUrl', {
      value: `${this.registryUrl.replace(/:\d+$/, '')}:7860`,
      description: 'Gradio UI URL (port 7860)',
    });

    if (config.enableObservability) {
      new cdk.CfnOutput(this, 'GrafanaUrl', {
        value: `${this.registryUrl}/grafana`,
        description: 'Grafana dashboard URL',
      });
    }

    new cdk.CfnOutput(this, 'ServiceEndpoints', {
      value: JSON.stringify({
        registry: `${this.registryUrl}`,
        registryApi: `${this.registryUrl}/api/v1`,
        registryHealth: `${this.registryUrl}/health`,
        keycloak: authStack.keycloakUrl,
        authServer: `${this.registryUrl}:8888`,
        gradioUi: `${this.registryUrl.replace(/:\d+$/, '')}:7860`,
      }),
      description: 'All service endpoints as JSON',
    });
  }
}


// ===========================================================================
// Private helper functions
// ===========================================================================


/**
 * Options for creating a Secrets Manager secret.
 */
interface CreateSecretOptions {
  /** Name prefix (for auto-generated names) */
  namePrefix?: string;
  /** Fixed name (exact secret name) */
  fixedName?: string;
  /** Description for the secret */
  description: string;
  /** KMS key for encryption */
  kmsKey: kms.IKey;
  /** If provided, create secret with a static string value */
  secretStringValue?: string;
  /** If provided, generate a random password */
  generateString?: {
    passwordLength: number;
    excludePunctuation: boolean;
  };
}


/**
 * Create a Secrets Manager secret with standard configuration.
 */
function _createSecret(
  scope: Construct,
  id: string,
  opts: CreateSecretOptions,
): secretsmanager.Secret {
  const secretProps: secretsmanager.SecretProps = {
    description: opts.description,
    encryptionKey: opts.kmsKey,
    removalPolicy: cdk.RemovalPolicy.DESTROY,
  };

  if (opts.fixedName) {
    (secretProps as any).secretName = opts.fixedName;
  }

  if (opts.generateString) {
    (secretProps as any).generateSecretString = {
      passwordLength: opts.generateString.passwordLength,
      excludePunctuation: opts.generateString.excludePunctuation,
    };
  }

  const secret = new secretsmanager.Secret(scope, id, secretProps);

  const cfnSecret = secret.node.defaultChild as secretsmanager.CfnSecret;

  // If using namePrefix, set it via L1
  if (opts.namePrefix) {
    cfnSecret.addPropertyOverride('Name', undefined);
    cfnSecret.name = undefined as any;
    // Use the CDK-generated name with a prefix approach via the secret name
    // The CDK secret name is auto-generated; we override with name prefix
    cfnSecret.addPropertyDeletionOverride('Name');
    cfnSecret.addPropertyOverride('Name', opts.namePrefix + cdk.Names.uniqueId(secret).slice(-8));
  }

  // If a static string value is provided, set it via L1
  if (opts.secretStringValue !== undefined && !opts.generateString) {
    cfnSecret.addPropertyOverride('SecretString', opts.secretStringValue);
    cfnSecret.addPropertyDeletionOverride('GenerateSecretString');
  }

  return secret;
}


/**
 * Extract DocumentDB endpoint from the data stack.
 * CfnDBCluster uses attrEndpoint for instance-based clusters.
 */
function _getDocumentDbEndpoint(dataStack: RegistryDataStack): string {
  if (dataStack.documentDbCluster) {
    return dataStack.documentDbCluster.attrEndpoint;
  }
  return '';
}


/**
 * Capitalize the first letter of a string.
 */
function _capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
