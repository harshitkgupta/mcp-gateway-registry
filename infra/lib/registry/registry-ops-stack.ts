/**
 * RegistryOpsStack - Secret rotation Lambdas for DocumentDB and Keycloak RDS.
 *
 * Translates terraform/aws-ecs/secret-rotation.tf and secret-rotation-config.tf
 * into AWS CDK.
 *
 * Creates:
 *   - IAM role + policies for rotation Lambdas
 *   - Lambda security group with egress to DocumentDB (27017), RDS (3306), HTTPS (443)
 *   - Ingress rules on DocumentDB SG and Keycloak DB SG from Lambda SG
 *   - DocumentDB rotation Lambda (using SecretRotation construct)
 *   - RDS rotation Lambda (using SecretRotation construct)
 *   - CfnRotationSchedule for both secrets (30-day auto rotation)
 *
 * This stack depends on RegistryNetworkStack and RegistryDataStack.
 */

import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as path from 'path';
import { Construct } from 'constructs';
import { RegistryConfig } from './registry-config';
import { RegistryNetworkStack } from './registry-network-stack';
import { RegistryDataStack } from './registry-data-stack';
import { SecretRotation } from './constructs/secret-rotation';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DOCUMENTDB_PORT = 27017;
const MYSQL_PORT = 3306;
const HTTPS_PORT = 443;
const ROTATION_INTERVAL_DAYS = 30;

// ---------------------------------------------------------------------------
// Stack props
// ---------------------------------------------------------------------------

export interface RegistryOpsStackProps extends cdk.StackProps {
  readonly config: RegistryConfig;
  readonly networkStack: RegistryNetworkStack;
  readonly dataStack: RegistryDataStack;
}

// ---------------------------------------------------------------------------
// Stack
// ---------------------------------------------------------------------------

export class RegistryOpsStack extends cdk.Stack {
  /** Security group for the rotation Lambda functions */
  public readonly rotationLambdaSg: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: RegistryOpsStackProps) {
    super(scope, id, props);

    const { config, networkStack, dataStack } = props;
    const { vpc, privateSubnets } = networkStack;
    const region = this.region;

    // ==================================================================
    // IAM role for rotation Lambda functions
    // ==================================================================

    const rotationRole = _createRotationRole(this, config, dataStack, region);

    // ==================================================================
    // Security group for rotation Lambdas
    // ==================================================================

    this.rotationLambdaSg = new ec2.SecurityGroup(this, 'RotationLambdaSg', {
      vpc,
      securityGroupName: `${config.name}-rotation-lambda-sg`,
      description: 'Security group for secret rotation Lambda functions',
      allowAllOutbound: false,
    });

    cdk.Tags.of(this.rotationLambdaSg).add('Name', `${config.name}-rotation-lambda-sg`);
    cdk.Tags.of(this.rotationLambdaSg).add('Component', 'secrets-rotation');

    // ------------------------------------------------------------------
    // Egress rules
    // ------------------------------------------------------------------

    // Lambda -> DocumentDB (27017)
    this.rotationLambdaSg.addEgressRule(
      ec2.Peer.securityGroupId(dataStack.documentDbSg.securityGroupId),
      ec2.Port.tcp(DOCUMENTDB_PORT),
      'Allow Lambda to connect to DocumentDB for rotation',
    );

    // Lambda -> RDS (3306)
    this.rotationLambdaSg.addEgressRule(
      ec2.Peer.securityGroupId(dataStack.keycloakDbSg.securityGroupId),
      ec2.Port.tcp(MYSQL_PORT),
      'Allow Lambda to connect to RDS for rotation',
    );

    // Lambda -> HTTPS 0.0.0.0/0 (Secrets Manager API)
    this.rotationLambdaSg.addEgressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(HTTPS_PORT),
      'Allow Lambda to call AWS APIs (Secrets Manager, KMS)',
    );

    // ------------------------------------------------------------------
    // Ingress rules on database security groups
    // Uses CfnSecurityGroupIngress to avoid cross-stack cyclic dependency
    // (Ops depends on Data, so Data SG objects cannot reference Ops SG)
    // ------------------------------------------------------------------

    // DocumentDB <- Lambda (27017)
    new ec2.CfnSecurityGroupIngress(this, 'DocDbFromLambda', {
      groupId: dataStack.documentDbSg.securityGroupId,
      ipProtocol: 'tcp',
      fromPort: DOCUMENTDB_PORT,
      toPort: DOCUMENTDB_PORT,
      sourceSecurityGroupId: this.rotationLambdaSg.securityGroupId,
      description: 'Allow Lambda rotation function to connect to DocumentDB',
    });

    // Keycloak DB <- Lambda (3306)
    new ec2.CfnSecurityGroupIngress(this, 'RdsFromLambda', {
      groupId: dataStack.keycloakDbSg.securityGroupId,
      ipProtocol: 'tcp',
      fromPort: MYSQL_PORT,
      toPort: MYSQL_PORT,
      sourceSecurityGroupId: this.rotationLambdaSg.securityGroupId,
      description: 'Allow Lambda rotation function to connect to RDS',
    });

    // ==================================================================
    // Lambda environment variables (shared by both functions)
    // ==================================================================

    const lambdaEnv: Record<string, string> = {
      SECRETS_MANAGER_ENDPOINT: `https://secretsmanager.${region}.amazonaws.com`,
      EXCLUDE_CHARACTERS: '/@"\'\\',
    };

    // ==================================================================
    // Lambda source code paths (reuse Terraform Lambda source)
    // ==================================================================

    const lambdaBasePath = path.join(
      __dirname, '..', '..', '..', 'terraform', 'aws-ecs', 'lambda',
    );

    // ==================================================================
    // DocumentDB rotation Lambda
    // ==================================================================

    const docdbRotation = new SecretRotation(this, 'DocumentDbRotation', {
      rotationName: `${config.name}-rotate-documentdb`,
      vpc,
      privateSubnets,
      lambdaSg: this.rotationLambdaSg,
      secretArn: dataStack.documentDbSecretArn,
      lambdaRole: rotationRole,
      lambdaCodePath: path.join(lambdaBasePath, 'rotate-documentdb'),
      environmentVariables: lambdaEnv,
    });

    // ==================================================================
    // RDS rotation Lambda
    // ==================================================================

    const rdsRotation = new SecretRotation(this, 'RdsRotation', {
      rotationName: `${config.name}-rotate-rds`,
      vpc,
      privateSubnets,
      lambdaSg: this.rotationLambdaSg,
      secretArn: dataStack.keycloakDbSecret.secretArn,
      lambdaRole: rotationRole,
      lambdaCodePath: path.join(lambdaBasePath, 'rotate-rds'),
      environmentVariables: lambdaEnv,
    });

    // ==================================================================
    // Rotation schedules (30-day auto rotation)
    // ==================================================================

    const docdbRotationSchedule = new secretsmanager.CfnRotationSchedule(
      this,
      'DocumentDbRotationSchedule',
      {
        secretId: dataStack.documentDbSecretArn,
        rotationLambdaArn: docdbRotation.lambdaFunction.functionArn,
        rotationRules: {
          automaticallyAfterDays: ROTATION_INTERVAL_DAYS,
        },
      },
    );

    // Ensure Lambda permission exists before Secrets Manager tries to invoke
    docdbRotationSchedule.node.addDependency(docdbRotation.lambdaFunction);

    const rdsRotationSchedule = new secretsmanager.CfnRotationSchedule(
      this,
      'RdsRotationSchedule',
      {
        secretId: dataStack.keycloakDbSecret.secretArn,
        rotationLambdaArn: rdsRotation.lambdaFunction.functionArn,
        rotationRules: {
          automaticallyAfterDays: ROTATION_INTERVAL_DAYS,
        },
      },
    );

    rdsRotationSchedule.node.addDependency(rdsRotation.lambdaFunction);

    // ------------------------------------------------------------------
    // Common tags
    // ------------------------------------------------------------------

    cdk.Tags.of(this).add('Project', 'mcp-gateway-registry');
    cdk.Tags.of(this).add('Component', 'ops');
    cdk.Tags.of(this).add('Environment', 'production');
    cdk.Tags.of(this).add('ManagedBy', 'cdk');
  }
}

// ---------------------------------------------------------------------------
// Private helper: create the IAM role and policies for rotation Lambdas
// ---------------------------------------------------------------------------

function _createRotationRole(
  scope: Construct,
  config: RegistryConfig,
  dataStack: RegistryDataStack,
  region: string,
): iam.Role {
  const role = new iam.Role(scope, 'RotationLambdaRole', {
    roleName: `${config.name}-secret-rotation-lambda`,
    assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
  });

  // ---- Secrets Manager access (both secrets) ----
  role.addToPolicy(
    new iam.PolicyStatement({
      sid: 'SecretsManagerAccess',
      effect: iam.Effect.ALLOW,
      actions: [
        'secretsmanager:DescribeSecret',
        'secretsmanager:GetSecretValue',
        'secretsmanager:PutSecretValue',
        'secretsmanager:UpdateSecretVersionStage',
      ],
      resources: [
        dataStack.documentDbSecretArn,
        dataStack.keycloakDbSecret.secretArn,
      ],
    }),
  );

  // ---- Generate random password (requires wildcard resource) ----
  role.addToPolicy(
    new iam.PolicyStatement({
      sid: 'GenerateRandomPassword',
      effect: iam.Effect.ALLOW,
      actions: ['secretsmanager:GetRandomPassword'],
      resources: ['*'],
    }),
  );

  // ---- KMS access (both keys) ----
  role.addToPolicy(
    new iam.PolicyStatement({
      sid: 'KMSAccess',
      effect: iam.Effect.ALLOW,
      actions: [
        'kms:Decrypt',
        'kms:DescribeKey',
        'kms:GenerateDataKey',
      ],
      resources: [
        dataStack.documentDbKmsKey.keyArn,
        dataStack.rdsKmsKey.keyArn,
      ],
    }),
  );

  // ---- RDS access (Keycloak Aurora cluster) ----
  // Build the ARN from the CfnDBCluster ref (cluster identifier)
  const keycloakClusterArn = cdk.Fn.sub(
    'arn:aws:rds:${AWS::Region}:${AWS::AccountId}:cluster:${ClusterId}',
    { ClusterId: dataStack.keycloakDbCluster.ref },
  );

  role.addToPolicy(
    new iam.PolicyStatement({
      sid: 'RDSAccess',
      effect: iam.Effect.ALLOW,
      actions: [
        'rds:DescribeDBInstances',
        'rds:DescribeDBClusters',
        'rds:ModifyDBCluster',
      ],
      resources: [keycloakClusterArn],
    }),
  );

  // ---- DocumentDB access ----
  // Build the ARN from the CfnDBCluster ref (cluster identifier)
  const documentDbClusterArn = cdk.Fn.sub(
    'arn:aws:rds:${AWS::Region}:${AWS::AccountId}:cluster:${ClusterId}',
    { ClusterId: dataStack.documentDbCluster.ref },
  );

  role.addToPolicy(
    new iam.PolicyStatement({
      sid: 'DocumentDBAccess',
      effect: iam.Effect.ALLOW,
      actions: [
        'docdb:DescribeDBClusters',
        'docdb:ModifyDBCluster',
      ],
      resources: [documentDbClusterArn],
    }),
  );

  // ---- VPC network interface management (requires wildcard resource) ----
  role.addToPolicy(
    new iam.PolicyStatement({
      sid: 'VPCNetworkInterface',
      effect: iam.Effect.ALLOW,
      actions: [
        'ec2:CreateNetworkInterface',
        'ec2:DescribeNetworkInterfaces',
        'ec2:DeleteNetworkInterface',
        'ec2:AssignPrivateIpAddresses',
        'ec2:UnassignPrivateIpAddresses',
      ],
      resources: ['*'],
    }),
  );

  // ---- Attach managed policy for Lambda VPC execution ----
  role.addManagedPolicy(
    iam.ManagedPolicy.fromAwsManagedPolicyName(
      'service-role/AWSLambdaVPCAccessExecutionRole',
    ),
  );

  return role;
}
