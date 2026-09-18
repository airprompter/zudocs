/**
 * The CI stack: GitHub's OIDC provider and the one role a deploy may assume.
 *
 * The role trusts exactly one subject — pushes to `main` of the configured
 * repository — and may do exactly one thing: assume the CDK bootstrap roles
 * in the three regions. Every resource permission lives on those bootstrap
 * roles (CDK's own execution role), so this role never needs widening and a
 * fork, a branch or a pull request can never deploy.
 *
 * @example
 * ```ts
 * new CiStack(app, "ZudocsCi", { config, env: { account: config.account, region: config.regions.site } });
 * // then in the workflow: role-to-assume: arn:aws:iam::<account>:role/zudocs-deploy
 * ```
 */
import * as cdk from "aws-cdk-lib";
import { aws_iam as iam } from "aws-cdk-lib";
import type { Construct } from "constructs";
import type { ZudocsConfig } from "./config.js";

export interface CiStackProps extends cdk.StackProps {
  readonly config: ZudocsConfig;
}

export const DEPLOY_ROLE_NAME = "zudocs-deploy";

export class CiStack extends cdk.Stack {
  readonly deployRole: iam.Role;

  constructor(scope: Construct, id: string, props: CiStackProps) {
    super(scope, id, props);
    const { github, account, regions } = props.config;
    const provider = new iam.OpenIdConnectProvider(this, "GitHub", {
      url: "https://token.actions.githubusercontent.com",
      clientIds: ["sts.amazonaws.com"],
    });
    this.deployRole = new iam.Role(this, "DeployRole", {
      roleName: DEPLOY_ROLE_NAME,
      description: `Deploys ${github.owner}/${github.repo} from ${github.branch} through the CDK bootstrap roles`,
      maxSessionDuration: cdk.Duration.hours(1),
      assumedBy: new iam.WebIdentityPrincipal(provider.openIdConnectProviderArn, {
        StringEquals: {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
          "token.actions.githubusercontent.com:sub": `repo:${github.owner}/${github.repo}:ref:refs/heads/${github.branch}`,
        },
      }),
    });
    // CDK v2 bootstrap roles: cdk-<qualifier>-{deploy-role,file-publishing-role,image-publishing-role,lookup-role}-<account>-<region>.
    const qualifier = "hnb659fds";
    this.deployRole.addToPolicy(new iam.PolicyStatement({
      actions: ["sts:AssumeRole"],
      resources: Object.values(regions).map((region) => `arn:aws:iam::${account}:role/cdk-${qualifier}-*-${account}-${region}`),
    }));
    new cdk.CfnOutput(this, "DeployRoleArn", { value: this.deployRole.roleArn });
  }
}
