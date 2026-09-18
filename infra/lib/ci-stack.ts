/**
 * The CI stack: GitHub's OIDC provider and the one role a deploy may assume.
 *
 * The role trusts exactly one subject — pushes to `main` of the configured
 * repository (the `ref:` form: the workflow's deploy job must therefore name
 * no GitHub environment, or the token's subject changes) — and may do exactly
 * one thing: assume the CDK bootstrap roles in the three regions. Every
 * resource permission lives on those bootstrap roles, so this role never needs
 * widening, and the region in each bootstrap role's name is the region fence.
 *
 * This stack is deployed from the owner's Identity Center session, never from
 * CI: the workflow that assumes the role must not be the thing that can break
 * the role.
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
const GITHUB_OIDC_URL = "https://token.actions.githubusercontent.com";
/** CDK v2's default bootstrap qualifier: the roles are named cdk-<qualifier>-<kind>-<account>-<region>. */
const BOOTSTRAP_QUALIFIER = "hnb659fds";

export class CiStack extends cdk.Stack {
  readonly deployRole: iam.Role;

  constructor(scope: Construct, id: string, props: CiStackProps) {
    super(scope, id, props);
    const { github, account, regions } = props.config;
    // The native resource: IAM trusts GitHub's certificate chain itself, no thumbprint, no custom resource.
    // An account holds one provider per URL; `--context githubOidcProviderArn=…` imports one that already exists.
    const existing = this.node.tryGetContext("githubOidcProviderArn") as string | undefined;
    const provider = existing
      ? iam.OidcProviderNative.fromOidcProviderArn(this, "GitHub", existing)
      : new iam.OidcProviderNative(this, "GitHub", { url: GITHUB_OIDC_URL, clientIds: ["sts.amazonaws.com"] });
    this.deployRole = new iam.Role(this, "DeployRole", {
      roleName: DEPLOY_ROLE_NAME,
      description: `Deploys ${github.owner}/${github.repo} from ${github.branch} through the CDK bootstrap roles`,
      maxSessionDuration: cdk.Duration.hours(1),
      assumedBy: new iam.WebIdentityPrincipal(provider.oidcProviderArn, {
        StringEquals: {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
          "token.actions.githubusercontent.com:sub": `repo:${github.owner}/${github.repo}:ref:refs/heads/${github.branch}`,
        },
      }),
    });
    this.deployRole.addToPolicy(new iam.PolicyStatement({
      actions: ["sts:AssumeRole"],
      resources: Object.values(regions).map((region) => `arn:aws:iam::${account}:role/cdk-${BOOTSTRAP_QUALIFIER}-*-${account}-${region}`),
    }));
    new cdk.CfnOutput(this, "DeployRoleArn", { value: this.deployRole.roleArn });
  }
}
