/**
 * CodeBuildPipeline - L3 construct that creates ECR repositories, an S3 artifacts
 * bucket, and a CodeBuild project for building all MCP Gateway container images.
 *
 * Translated from: terraform/aws-ecs/codebuild.tf
 *
 * This construct is a no-op when `config.createCodebuild` is false: no resources
 * are synthesised and all exported properties are undefined.
 */

import * as cdk from 'aws-cdk-lib';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { RegistryConfig } from '../registry-config';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** All service images that CodeBuild will build and push. */
const ECR_REPOSITORY_NAMES: readonly string[] = [
  'mcp-gateway-registry',
  'mcp-gateway-auth-server',
  'mcp-gateway-currenttime',
  'mcp-gateway-mcpgw',
  'mcp-gateway-realserverfaketools',
  'mcp-gateway-flight-booking-agent',
  'mcp-gateway-travel-assistant-agent',
  'mcp-gateway-scopes-init',
  'mcp-gateway-metrics-service',
  'mcp-gateway-grafana',
] as const;

/** Maximum number of sha-* tagged images to keep per repository. */
const ECR_MAX_TAGGED_IMAGES = 10;

/** Days after which untagged images are expired. */
const ECR_UNTAGGED_EXPIRY_DAYS = 7;

/** S3 artifact expiration in days. */
const S3_ARTIFACT_EXPIRY_DAYS = 90;

/** S3 noncurrent version expiration in days. */
const S3_NONCURRENT_EXPIRY_DAYS = 30;

/** CodeBuild timeout in minutes. */
const CODEBUILD_TIMEOUT_MINUTES = 60;

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface CodeBuildPipelineProps {
  readonly config: RegistryConfig;
}

// ---------------------------------------------------------------------------
// Construct
// ---------------------------------------------------------------------------

export class CodeBuildPipeline extends Construct {
  /** CodeBuild project name (undefined when createCodebuild is false) */
  public readonly codebuildProjectName: string | undefined;

  /** Map of repository name to its URI (undefined when createCodebuild is false) */
  public readonly ecrRepositoryUrls: Record<string, string> | undefined;

  /** S3 artifacts bucket name (undefined when createCodebuild is false) */
  public readonly s3BucketName: string | undefined;

  constructor(scope: Construct, id: string, props: CodeBuildPipelineProps) {
    super(scope, id);

    const { config } = props;

    // No-op when CodeBuild is disabled
    if (!config.createCodebuild) {
      this.codebuildProjectName = undefined;
      this.ecrRepositoryUrls = undefined;
      this.s3BucketName = undefined;
      return;
    }

    const accountId = cdk.Stack.of(this).account;
    const region = cdk.Stack.of(this).region;

    // ------------------------------------------------------------------
    // ECR Repositories
    // ------------------------------------------------------------------

    const repositories = this._createEcrRepositories(config);

    // ------------------------------------------------------------------
    // S3 Bucket for CodeBuild artifacts
    // ------------------------------------------------------------------

    const artifactsBucket = this._createArtifactsBucket(accountId, config);

    // ------------------------------------------------------------------
    // IAM Role for CodeBuild
    // ------------------------------------------------------------------

    const codebuildRole = this._createCodeBuildRole(
      accountId,
      region,
      artifactsBucket,
      config,
    );

    // ------------------------------------------------------------------
    // CodeBuild Project
    // ------------------------------------------------------------------

    const project = this._createCodeBuildProject(codebuildRole, config);

    // ------------------------------------------------------------------
    // Exports
    // ------------------------------------------------------------------

    this.codebuildProjectName = project.projectName;
    this.s3BucketName = artifactsBucket.bucketName;

    const urls: Record<string, string> = {};
    for (const [name, repo] of Object.entries(repositories)) {
      urls[name] = `${repo.repositoryUri}:latest`;
    }
    this.ecrRepositoryUrls = urls;
  }

  // ======================================================================
  // Private helpers
  // ======================================================================

  /**
   * Create all ECR repositories with lifecycle policies.
   */
  private _createEcrRepositories(
    config: RegistryConfig,
  ): Record<string, ecr.Repository> {
    const repos: Record<string, ecr.Repository> = {};

    for (const repoName of ECR_REPOSITORY_NAMES) {
      const repo = new ecr.Repository(this, `Ecr-${repoName}`, {
        repositoryName: repoName,
        imageTagMutability: ecr.TagMutability.MUTABLE,
        imageScanOnPush: true,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
        emptyOnDelete: true,
        lifecycleRules: [
          {
            rulePriority: 10,
            description: `Keep last ${ECR_MAX_TAGGED_IMAGES} tagged images`,
            tagStatus: ecr.TagStatus.TAGGED,
            tagPrefixList: ['sha-'],
            maxImageCount: ECR_MAX_TAGGED_IMAGES,
          },
          {
            rulePriority: 20,
            description: `Expire untagged images older than ${ECR_UNTAGGED_EXPIRY_DAYS} days`,
            tagStatus: ecr.TagStatus.UNTAGGED,
            maxImageAge: cdk.Duration.days(ECR_UNTAGGED_EXPIRY_DAYS),
          },
        ],
      });

      cdk.Tags.of(repo).add('Name', repoName);
      cdk.Tags.of(repo).add('Component', 'codebuild');
      cdk.Tags.of(repo).add('Service', config.name);

      repos[repoName] = repo;
    }

    return repos;
  }

  /**
   * Create the S3 bucket used for CodeBuild buildspec and artifacts storage.
   */
  private _createArtifactsBucket(
    accountId: string,
    config: RegistryConfig,
  ): s3.Bucket {
    const bucket = new s3.Bucket(this, 'ArtifactsBucket', {
      bucketName: `mcp-gateway-codebuild-${accountId}`,
      versioned: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      lifecycleRules: [
        {
          id: 'delete-old-artifacts',
          enabled: true,
          expiration: cdk.Duration.days(S3_ARTIFACT_EXPIRY_DAYS),
          noncurrentVersionExpiration: cdk.Duration.days(S3_NONCURRENT_EXPIRY_DAYS),
        },
      ],
    });

    cdk.Tags.of(bucket).add('Name', 'mcp-gateway-codebuild');
    cdk.Tags.of(bucket).add('Component', 'codebuild');
    cdk.Tags.of(bucket).add('Service', config.name);

    return bucket;
  }

  /**
   * Create the IAM role for CodeBuild with minimal permissions.
   */
  private _createCodeBuildRole(
    accountId: string,
    region: string,
    artifactsBucket: s3.Bucket,
    config: RegistryConfig,
  ): iam.Role {
    const role = new iam.Role(this, 'CodeBuildRole', {
      roleName: `${config.name}-codebuild-role`,
      assumedBy: new iam.ServicePrincipal('codebuild.amazonaws.com'),
    });

    // CloudWatch Logs (scoped to CodeBuild log groups)
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'CloudWatchLogs',
        effect: iam.Effect.ALLOW,
        actions: [
          'logs:CreateLogGroup',
          'logs:CreateLogStream',
          'logs:PutLogEvents',
        ],
        resources: [
          `arn:aws:logs:${region}:${accountId}:log-group:/aws/codebuild/${config.name}-*`,
          `arn:aws:logs:${region}:${accountId}:log-group:/aws/codebuild/${config.name}-*:*`,
        ],
      }),
    );

    // ECR authentication
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'EcrAuth',
        effect: iam.Effect.ALLOW,
        actions: ['ecr:GetAuthorizationToken'],
        resources: ['*'],
      }),
    );

    // ECR push/pull (scoped to managed repositories)
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'EcrPushPull',
        effect: iam.Effect.ALLOW,
        actions: [
          'ecr:BatchCheckLayerAvailability',
          'ecr:GetDownloadUrlForLayer',
          'ecr:BatchGetImage',
          'ecr:PutImage',
          'ecr:InitiateLayerUpload',
          'ecr:UploadLayerPart',
          'ecr:CompleteLayerUpload',
        ],
        resources: ECR_REPOSITORY_NAMES.map(
          (name) => `arn:aws:ecr:${region}:${accountId}:repository/${name}`,
        ),
      }),
    );

    // S3 read for buildspec
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'S3ReadArtifacts',
        effect: iam.Effect.ALLOW,
        actions: [
          's3:GetObject',
          's3:GetObjectVersion',
        ],
        resources: [`${artifactsBucket.bucketArn}/*`],
      }),
    );

    // STS for account ID lookup in build
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'StsIdentity',
        effect: iam.Effect.ALLOW,
        actions: ['sts:GetCallerIdentity'],
        resources: ['*'],
      }),
    );

    cdk.Tags.of(role).add('Component', 'codebuild');
    cdk.Tags.of(role).add('Service', config.name);

    return role;
  }

  /**
   * Create the CodeBuild project that builds all container images in parallel.
   */
  private _createCodeBuildProject(
    role: iam.Role,
    config: RegistryConfig,
  ): codebuild.Project {
    const project = new codebuild.Project(this, 'UpstreamBuild', {
      projectName: `${config.name}-upstream-build`,
      description: 'Build MCP Gateway container images (all services + observability pipeline)',
      timeout: cdk.Duration.minutes(CODEBUILD_TIMEOUT_MINUTES),
      role,
      source: codebuild.Source.gitHub({
        owner: 'agentic-community',
        repo: 'mcp-gateway-registry',
        branchOrRef: 'main',
        cloneDepth: 1,
        fetchSubmodules: false,
      }),
      environment: {
        buildImage: codebuild.LinuxBuildImage.AMAZON_LINUX_2_5,
        computeType: codebuild.ComputeType.LARGE,
        privileged: true,
      },
      cache: codebuild.Cache.local(
        codebuild.LocalCacheMode.DOCKER_LAYER,
        codebuild.LocalCacheMode.SOURCE,
      ),
      buildSpec: codebuild.BuildSpec.fromObject(this._buildSpecDefinition()),
    });

    cdk.Tags.of(project).add('Component', 'codebuild');
    cdk.Tags.of(project).add('Service', config.name);

    return project;
  }

  /**
   * Return the inline buildspec definition that builds all containers in parallel.
   */
  private _buildSpecDefinition(): Record<string, unknown> {
    return {
      version: '0.2',
      env: {
        variables: {
          DOCKER_BUILDKIT: '1',
        },
      },
      phases: {
        pre_build: {
          commands: [
            'echo "=== Building MCP Gateway container images ==="',
            'echo "Source version - $CODEBUILD_RESOLVED_SOURCE_VERSION"',
            'export AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)',
            'export ECR_REGISTRY="${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_DEFAULT_REGION}.amazonaws.com"',
            'export IMAGE_TAG="sha-${CODEBUILD_RESOLVED_SOURCE_VERSION:0:7}"',
            'echo "ECR Registry - $ECR_REGISTRY"',
            'echo "Image tag - $IMAGE_TAG"',
            'aws ecr get-login-password --region $AWS_DEFAULT_REGION | docker login --username AWS --password-stdin $ECR_REGISTRY',
            'echo "Pre-pulling base images for layer caching..."',
            'docker pull public.ecr.aws/docker/library/python:3.14-slim || true',
            'docker tag public.ecr.aws/docker/library/python:3.14-slim python:3.14-slim',
            'docker pull quay.io/keycloak/keycloak:23.0 || true',
            'docker pull grafana/grafana:12.3.1 || true',
            'echo "Pulling existing images for cache..."',
            'for repo in mcp-gateway-registry mcp-gateway-auth-server keycloak mcp-gateway-currenttime mcp-gateway-mcpgw mcp-gateway-realserverfaketools mcp-gateway-flight-booking-agent mcp-gateway-travel-assistant-agent mcp-gateway-scopes-init mcp-gateway-metrics-service mcp-gateway-grafana; do docker pull $ECR_REGISTRY/$repo:latest 2>/dev/null || true; done',
            'echo "Setting up A2A agent dependencies..."',
            'mkdir -p agents/a2a/src/flight-booking-agent/.tmp agents/a2a/src/travel-assistant-agent/.tmp',
            'cp agents/a2a/pyproject.toml agents/a2a/uv.lock agents/a2a/src/flight-booking-agent/.tmp/ 2>/dev/null || true',
            'cp agents/a2a/pyproject.toml agents/a2a/uv.lock agents/a2a/src/travel-assistant-agent/.tmp/ 2>/dev/null || true',
          ],
        },
        build: {
          commands: [
            'echo "=== Building all container images in parallel ==="',
            [
              'build_and_push() {',
              '  local name=$1',
              '  local dockerfile=$2',
              '  local context=$3',
              '  echo "Starting build: $name"',
              '  if docker build --cache-from $ECR_REGISTRY/$name:latest \\',
              '       -t $ECR_REGISTRY/$name:$IMAGE_TAG \\',
              '       --build-arg BUILD_VERSION=$IMAGE_TAG \\',
              '       -f $dockerfile $context && \\',
              '     docker tag $ECR_REGISTRY/$name:$IMAGE_TAG $ECR_REGISTRY/$name:latest && \\',
              '     docker push $ECR_REGISTRY/$name:$IMAGE_TAG && \\',
              '     docker push $ECR_REGISTRY/$name:latest; then',
              '    echo "Completed: $name"',
              '  else',
              '    echo "FAILED: $name"',
              '    return 1',
              '  fi',
              '}',
              '',
              '# Core services',
              'build_and_push mcp-gateway-registry docker/Dockerfile.registry-cpu . &',
              'build_and_push mcp-gateway-auth-server docker/Dockerfile.auth . &',
              '',
              '# MCP servers',
              'build_and_push mcp-gateway-currenttime docker/Dockerfile.mcp-server servers/currenttime &',
              '(docker build --cache-from $ECR_REGISTRY/mcp-gateway-mcpgw:latest \\',
              '  -t $ECR_REGISTRY/mcp-gateway-mcpgw:$IMAGE_TAG \\',
              '  --build-arg SERVER_DIR=servers/mcpgw --build-arg BUILD_VERSION=$IMAGE_TAG \\',
              '  -f docker/Dockerfile.mcp-server-cpu . && \\',
              '  docker tag $ECR_REGISTRY/mcp-gateway-mcpgw:$IMAGE_TAG $ECR_REGISTRY/mcp-gateway-mcpgw:latest && \\',
              '  docker push $ECR_REGISTRY/mcp-gateway-mcpgw:$IMAGE_TAG && \\',
              '  docker push $ECR_REGISTRY/mcp-gateway-mcpgw:latest && \\',
              '  echo "Completed: mcp-gateway-mcpgw" || { echo "FAILED: mcp-gateway-mcpgw"; exit 1; }) &',
              'build_and_push mcp-gateway-realserverfaketools docker/Dockerfile.mcp-server servers/realserverfaketools &',
              '',
              '# A2A agents',
              'build_and_push mcp-gateway-flight-booking-agent agents/a2a/src/flight-booking-agent/Dockerfile agents/a2a/src/flight-booking-agent &',
              'build_and_push mcp-gateway-travel-assistant-agent agents/a2a/src/travel-assistant-agent/Dockerfile agents/a2a/src/travel-assistant-agent &',
              '',
              '# Utilities',
              'build_and_push mcp-gateway-scopes-init docker/Dockerfile.scopes-init . &',
              '',
              '# Observability pipeline',
              'build_and_push mcp-gateway-metrics-service metrics-service/Dockerfile metrics-service &',
              'build_and_push mcp-gateway-grafana terraform/aws-ecs/grafana/Dockerfile terraform/aws-ecs/grafana &',
              '',
              '# Wait for all background jobs',
              'FAILED=0',
              'for job in $(jobs -p); do',
              '  wait $job || FAILED=$((FAILED+1))',
              'done',
              '',
              'if [ $FAILED -gt 0 ]; then',
              '  echo "$FAILED build(s) failed"',
              '  exit 1',
              'fi',
              'echo "All builds completed successfully"',
            ].join('\n'),
          ],
        },
        post_build: {
          commands: [
            'echo "Build completed on $(date)"',
            'echo "All images pushed to $ECR_REGISTRY with tags $IMAGE_TAG and latest"',
          ],
        },
      },
    };
  }
}
