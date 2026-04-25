/**
 * RegistryDataStack - Translates documentdb.tf and keycloak-database.tf into AWS CDK.
 *
 * Creates:
 *   - DocumentDB cluster (via DocumentDbCluster construct)
 *   - Aurora MySQL Serverless v2 for Keycloak (KMS, Secrets Manager, RDS Proxy)
 *
 * Security groups are created with egress-only. Ingress rules are added by
 * downstream stacks (RegistryServiceStack, RegistryAuthStack, RegistryOpsStack).
 *
 * Cross-stack exports are exposed as public readonly properties.
 */

import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import { RegistryConfig } from './registry-config';
import { RegistryNetworkStack } from './registry-network-stack';
import { DocumentDbCluster } from './constructs/documentdb-cluster';

// ---------------------------------------------------------------------------
// Stack props
// ---------------------------------------------------------------------------

export interface RegistryDataStackProps extends cdk.StackProps {
  readonly config: RegistryConfig;
  readonly networkStack: RegistryNetworkStack;
}

// ---------------------------------------------------------------------------
// Stack
// ---------------------------------------------------------------------------

export class RegistryDataStack extends cdk.Stack {
  // -- DocumentDB exports --
  /** The DocumentDB CfnDBCluster resource */
  public readonly documentDbCluster: import('aws-cdk-lib/aws-docdb').CfnDBCluster;

  /** Security group for DocumentDB */
  public readonly documentDbSg: ec2.SecurityGroup;

  /** KMS key for DocumentDB encryption */
  public readonly documentDbKmsKey: kms.Key;

  /** ARN of the Secrets Manager secret for DocumentDB credentials */
  public readonly documentDbSecretArn: string;

  // -- Keycloak DB exports --
  /** The Aurora MySQL RDS cluster for Keycloak */
  public readonly keycloakDbCluster: rds.CfnDBCluster;

  /** RDS Proxy endpoint for Keycloak DB connections */
  public readonly keycloakDbProxy: rds.CfnDBProxy;

  /** Secrets Manager secret for Keycloak DB credentials */
  public readonly keycloakDbSecret: secretsmanager.Secret;

  /** Security group for Keycloak DB */
  public readonly keycloakDbSg: ec2.SecurityGroup;

  /** KMS key for RDS encryption */
  public readonly rdsKmsKey: kms.Key;

  constructor(scope: Construct, id: string, props: RegistryDataStackProps) {
    super(scope, id, props);

    const { config, networkStack } = props;
    const { vpc, privateSubnets } = networkStack;
    const region = this.region;
    const accountId = this.account;

    // ==================================================================
    // DocumentDB Cluster (via L3 construct)
    // ==================================================================

    const docdb = new DocumentDbCluster(this, 'DocumentDb', {
      vpc,
      privateSubnets,
      config,
    });

    this.documentDbCluster = docdb.cluster;
    this.documentDbSg = docdb.sg;
    this.documentDbKmsKey = docdb.kmsKey;
    this.documentDbSecretArn = docdb.secretArn;

    // ==================================================================
    // Aurora MySQL Serverless v2 for Keycloak
    // ==================================================================

    // ------------------------------------------------------------------
    // KMS key for RDS encryption
    // ------------------------------------------------------------------

    this.rdsKmsKey = new kms.Key(this, 'RdsKmsKey', {
      description: 'KMS key for RDS and secrets encryption',
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      pendingWindow: cdk.Duration.days(7),
    });

    // Key policy: Allow ECS task execution roles to decrypt
    this.rdsKmsKey.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowEcsTaskExecDecrypt',
        effect: iam.Effect.ALLOW,
        principals: [new iam.AnyPrincipal()],
        actions: ['kms:Decrypt', 'kms:DescribeKey'],
        resources: ['*'],
        conditions: {
          StringEquals: {
            'aws:PrincipalAccount': accountId,
          },
          StringLike: {
            'aws:PrincipalArn': `arn:aws:iam::${accountId}:role/*task-exec*`,
          },
        },
      }),
    );

    // Key policy: Allow RDS service
    this.rdsKmsKey.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowRdsService',
        effect: iam.Effect.ALLOW,
        principals: [new iam.ServicePrincipal('rds.amazonaws.com')],
        actions: ['kms:Decrypt', 'kms:DescribeKey', 'kms:CreateGrant'],
        resources: ['*'],
        conditions: {
          StringEquals: {
            'kms:ViaService': `rds.${region}.amazonaws.com`,
          },
        },
      }),
    );

    // Key policy: Allow CloudWatch Logs
    this.rdsKmsKey.addToResourcePolicy(
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

    new kms.Alias(this, 'RdsKmsAlias', {
      aliasName: 'alias/keycloak-rds',
      targetKey: this.rdsKmsKey,
    });

    // ------------------------------------------------------------------
    // Secrets Manager secret for Keycloak DB credentials
    // ------------------------------------------------------------------

    this.keycloakDbSecret = new secretsmanager.Secret(this, 'KeycloakDbSecret', {
      secretName: 'keycloak/database',
      description: 'Keycloak database credentials',
      encryptionKey: this.rdsKmsKey,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const cfnKeycloakSecret = this.keycloakDbSecret.node.defaultChild as secretsmanager.CfnSecret;
    cfnKeycloakSecret.addPropertyOverride('SecretString', JSON.stringify({
      username: config.keycloak.databaseUsername,
      password: config.keycloak.databasePassword,
    }));
    cfnKeycloakSecret.addPropertyDeletionOverride('GenerateSecretString');

    // ------------------------------------------------------------------
    // Security group for Keycloak DB (egress-only)
    // ------------------------------------------------------------------

    this.keycloakDbSg = new ec2.SecurityGroup(this, 'KeycloakDbSg', {
      vpc,
      securityGroupName: 'keycloak-db',
      description: 'Security group for Keycloak database',
      allowAllOutbound: true,
    });

    cdk.Tags.of(this.keycloakDbSg).add('Name', 'keycloak-db');

    // ------------------------------------------------------------------
    // DB subnet group for Keycloak
    // ------------------------------------------------------------------

    const keycloakSubnetGroup = new rds.CfnDBSubnetGroup(this, 'KeycloakSubnetGroup', {
      dbSubnetGroupDescription: 'Subnet group for Keycloak Aurora MySQL cluster',
      dbSubnetGroupName: 'keycloak-subnet-group',
      subnetIds: privateSubnets.map((s) => s.subnetId),
      tags: [
        { key: 'Name', value: 'keycloak-subnet-group' },
      ],
    });

    // ------------------------------------------------------------------
    // RDS cluster parameter group
    // ------------------------------------------------------------------

    const keycloakParamGroup = new rds.CfnDBClusterParameterGroup(this, 'KeycloakParamGroup', {
      family: 'aurora-mysql8.0',
      description: 'Keycloak Aurora MySQL parameter group',
      dbClusterParameterGroupName: 'keycloak-params',
      parameters: {
        character_set_server: 'utf8mb4',
        collation_server: 'utf8mb4_unicode_ci',
      },
    });

    // ------------------------------------------------------------------
    // Aurora MySQL Serverless v2 cluster
    // ------------------------------------------------------------------

    this.keycloakDbCluster = new rds.CfnDBCluster(this, 'KeycloakCluster', {
      dbClusterIdentifier: 'keycloak',
      engine: 'aurora-mysql',
      engineVersion: '8.0.mysql_aurora.3.10.3',
      databaseName: 'keycloak',
      masterUsername: config.keycloak.databaseUsername,
      masterUserPassword: config.keycloak.databasePassword,
      dbSubnetGroupName: keycloakSubnetGroup.dbSubnetGroupName,
      dbClusterParameterGroupName: keycloakParamGroup.dbClusterParameterGroupName,
      vpcSecurityGroupIds: [this.keycloakDbSg.securityGroupId],
      backupRetentionPeriod: 7,
      preferredBackupWindow: '02:00-04:00',
      preferredMaintenanceWindow: 'sun:04:00-sun:05:00',
      copyTagsToSnapshot: true,
      storageEncrypted: true,
      kmsKeyId: this.rdsKmsKey.keyArn,
      deletionProtection: false,
      serverlessV2ScalingConfiguration: {
        maxCapacity: config.keycloak.databaseMaxAcu,
        minCapacity: config.keycloak.databaseMinAcu,
      },
    });

    this.keycloakDbCluster.addDependency(keycloakSubnetGroup);
    this.keycloakDbCluster.addDependency(keycloakParamGroup);

    // ------------------------------------------------------------------
    // Aurora cluster instance (Serverless v2)
    // ------------------------------------------------------------------

    const keycloakInstance = new rds.CfnDBInstance(this, 'KeycloakInstance', {
      dbClusterIdentifier: this.keycloakDbCluster.ref,
      dbInstanceClass: 'db.serverless',
      engine: 'aurora-mysql',
      engineVersion: '8.0.mysql_aurora.3.10.3',
      autoMinorVersionUpgrade: true,
    });

    keycloakInstance.addDependency(this.keycloakDbCluster);

    // ------------------------------------------------------------------
    // IAM role for RDS Proxy
    // ------------------------------------------------------------------

    const rdsProxyRole = new iam.Role(this, 'RdsProxyRole', {
      roleName: `keycloak-rds-proxy-role-${config.awsRegion}`,
      assumedBy: new iam.ServicePrincipal('rds.amazonaws.com'),
    });

    rdsProxyRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['secretsmanager:GetSecretValue'],
        resources: [this.keycloakDbSecret.secretArn],
      }),
    );

    rdsProxyRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['kms:Decrypt'],
        resources: [this.rdsKmsKey.keyArn],
      }),
    );

    // ------------------------------------------------------------------
    // RDS Proxy
    // ------------------------------------------------------------------

    // Self-referencing ingress so the proxy can reach the Aurora cluster on 3306
    this.keycloakDbSg.addIngressRule(
      this.keycloakDbSg,
      ec2.Port.tcp(3306),
      'RDS Proxy self-referencing rule for Aurora MySQL',
    );

    this.keycloakDbProxy = new rds.CfnDBProxy(this, 'KeycloakProxy', {
      dbProxyName: 'keycloak-proxy',
      engineFamily: 'MYSQL',
      auth: [
        {
          authScheme: 'SECRETS',
          secretArn: this.keycloakDbSecret.secretArn,
          clientPasswordAuthType: 'MYSQL_CACHING_SHA2_PASSWORD',
          iamAuth: 'DISABLED',
        },
      ],
      roleArn: rdsProxyRole.roleArn,
      vpcSubnetIds: privateSubnets.map((s) => s.subnetId),
      vpcSecurityGroupIds: [this.keycloakDbSg.securityGroupId],
      requireTls: false,
    });

    this.keycloakDbProxy.addDependency(keycloakInstance);

    // RDS Proxy target group attaches the proxy to the cluster
    const proxyTargetGroup = new rds.CfnDBProxyTargetGroup(this, 'KeycloakProxyTarget', {
      dbProxyName: this.keycloakDbProxy.dbProxyName!,
      targetGroupName: 'default',
      dbClusterIdentifiers: [this.keycloakDbCluster.ref],
    });

    proxyTargetGroup.addDependency(this.keycloakDbProxy);
    proxyTargetGroup.addDependency(keycloakInstance);

    // ------------------------------------------------------------------
    // SSM parameters for Keycloak DB (SecureString via L1)
    // ------------------------------------------------------------------

    const keycloakDbUrl = cdk.Fn.join('', [
      'jdbc:mysql://',
      this.keycloakDbCluster.attrEndpointAddress,
      ':3306/keycloak',
    ]);

    const ssmParamArns = [
      this.formatArn({ service: 'ssm', resource: 'parameter', resourceName: 'keycloak/database/*' }),
    ];
    const ssmKmsActions = new iam.PolicyStatement({
      actions: ['kms:Encrypt', 'kms:GenerateDataKey'],
      resources: [this.rdsKmsKey.keyArn],
    });
    const ssmPutPolicy = new iam.PolicyStatement({
      actions: ['ssm:PutParameter', 'ssm:DeleteParameter', 'ssm:AddTagsToResource'],
      resources: ssmParamArns,
    });

    const keycloakSsmParams: Array<{ id: string; name: string; value: string }> = [
      { id: 'KeycloakDbUrlParam', name: '/keycloak/database/url', value: keycloakDbUrl },
      { id: 'KeycloakDbUsernameParam', name: '/keycloak/database/username', value: config.keycloak.databaseUsername },
      { id: 'KeycloakDbPasswordParam', name: '/keycloak/database/password', value: config.keycloak.databasePassword },
    ];

    for (const param of keycloakSsmParams) {
      new cr.AwsCustomResource(this, param.id, {
        onCreate: {
          service: 'SSM',
          action: 'putParameter',
          parameters: {
            Name: param.name,
            Type: 'SecureString',
            KeyId: this.rdsKmsKey.keyId,
            Value: param.value,
            Overwrite: true,
          },
          physicalResourceId: cr.PhysicalResourceId.of(param.name),
        },
        onUpdate: {
          service: 'SSM',
          action: 'putParameter',
          parameters: {
            Name: param.name,
            Type: 'SecureString',
            KeyId: this.rdsKmsKey.keyId,
            Value: param.value,
            Overwrite: true,
          },
          physicalResourceId: cr.PhysicalResourceId.of(param.name),
        },
        onDelete: {
          service: 'SSM',
          action: 'deleteParameter',
          parameters: { Name: param.name },
        },
        policy: cr.AwsCustomResourcePolicy.fromStatements([ssmPutPolicy, ssmKmsActions]),
      });
    }

    // ------------------------------------------------------------------
    // Common tags
    // ------------------------------------------------------------------

    cdk.Tags.of(this).add('Project', 'mcp-gateway-registry');
    cdk.Tags.of(this).add('Component', 'data');
    cdk.Tags.of(this).add('Environment', 'production');
    cdk.Tags.of(this).add('ManagedBy', 'cdk');
  }
}
