/**
 * RegistryNetworkStack - Translates vpc.tf into AWS CDK.
 *
 * Creates:
 *   - VPC with configurable CIDR (default 10.0.0.0/16)
 *   - 3 AZs, private subnets (/20), public subnets (/24)
 *   - NAT gateways: one per AZ (3 total)
 *   - STS interface VPC endpoint (private DNS enabled)
 *   - S3 gateway VPC endpoint
 *   - VPC endpoints security group (ingress 443 from VPC CIDR)
 *
 * Cross-stack exports are exposed as public readonly properties.
 */

import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';
import { RegistryConfig } from './registry-config';

// ---------------------------------------------------------------------------
// Stack props
// ---------------------------------------------------------------------------

export interface RegistryNetworkStackProps extends cdk.StackProps {
  readonly config: RegistryConfig;
}

// ---------------------------------------------------------------------------
// Stack
// ---------------------------------------------------------------------------

export class RegistryNetworkStack extends cdk.Stack {
  /** The VPC created by this stack */
  public readonly vpc: ec2.Vpc;

  /** Private subnets (one per AZ, /20 CIDR) */
  public readonly privateSubnets: ec2.ISubnet[];

  /** Public subnets (one per AZ, /24 CIDR) */
  public readonly publicSubnets: ec2.ISubnet[];

  /** Security group for VPC interface endpoints */
  public readonly vpcEndpointsSg: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: RegistryNetworkStackProps) {
    super(scope, id, props);

    const config = props.config;

    // ------------------------------------------------------------------
    // VPC
    // ------------------------------------------------------------------
    // Terraform module uses:
    //   private_subnets = cidrsubnet(vpc_cidr, 4, k)  -> /20 for a /16 VPC
    //   public_subnets  = cidrsubnet(vpc_cidr, 8, k+48) -> /24 for a /16 VPC
    //
    // CDK Vpc L2 handles subnet CIDR allocation automatically based on
    // the subnet mask bits we provide.
    // ------------------------------------------------------------------

    this.vpc = new ec2.Vpc(this, 'Vpc', {
      vpcName: `${config.name}-vpc`,
      ipAddresses: ec2.IpAddresses.cidr(config.vpcCidr),
      maxAzs: 3,
      natGateways: 3, // one per AZ, matching Terraform one_nat_gateway_per_az
      enableDnsHostnames: true,
      enableDnsSupport: true,
      subnetConfiguration: [
        {
          cidrMask: 20,
          name: 'private',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        },
        {
          cidrMask: 24,
          name: 'public',
          subnetType: ec2.SubnetType.PUBLIC,
        },
      ],
    });

    // Expose subnet selections for cross-stack consumption
    this.privateSubnets = this.vpc.selectSubnets({
      subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
    }).subnets;

    this.publicSubnets = this.vpc.selectSubnets({
      subnetType: ec2.SubnetType.PUBLIC,
    }).subnets;

    // ------------------------------------------------------------------
    // Subnet tags (matching Terraform)
    // ------------------------------------------------------------------

    for (const subnet of this.privateSubnets) {
      cdk.Tags.of(subnet).add('subnet-type', 'private');
    }
    for (const subnet of this.publicSubnets) {
      cdk.Tags.of(subnet).add('subnet-type', 'public');
    }

    // ------------------------------------------------------------------
    // VPC endpoints security group
    // ------------------------------------------------------------------

    this.vpcEndpointsSg = new ec2.SecurityGroup(this, 'VpcEndpointsSg', {
      vpc: this.vpc,
      securityGroupName: `${config.name}-vpc-endpoints`,
      description: 'Security group for VPC interface endpoints allowing HTTPS from within VPC',
      allowAllOutbound: true,
    });

    this.vpcEndpointsSg.addIngressRule(
      ec2.Peer.ipv4(config.vpcCidr),
      ec2.Port.tcp(443),
      'Allow HTTPS from VPC CIDR for AWS service endpoints',
    );

    // ------------------------------------------------------------------
    // STS interface VPC endpoint
    // ------------------------------------------------------------------

    this.vpc.addInterfaceEndpoint('StsEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.STS,
      subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [this.vpcEndpointsSg],
      privateDnsEnabled: true,
    });

    // ------------------------------------------------------------------
    // S3 gateway VPC endpoint
    // ------------------------------------------------------------------

    this.vpc.addGatewayEndpoint('S3Endpoint', {
      service: ec2.GatewayVpcEndpointAwsService.S3,
      subnets: [{ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }],
    });

    // ------------------------------------------------------------------
    // Common tags
    // ------------------------------------------------------------------

    cdk.Tags.of(this).add('Project', 'mcp-gateway-registry');
    cdk.Tags.of(this).add('Component', 'network');
    cdk.Tags.of(this).add('Environment', 'production');
    cdk.Tags.of(this).add('ManagedBy', 'cdk');
  }
}
