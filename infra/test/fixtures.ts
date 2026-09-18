/**
 * Shared stand-ins for the infra tests: the context `cdk.json` carries, the feature flags, directories that stand for
 * the built artefacts (the stacks only need them to exist), the AirPrompter identifiers, the pins, and one `synth`
 * that builds every stack on one app before the first template is read.
 *
 * @example
 * ```ts
 * const { desk, sharedHost } = synthAll();
 * ```
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { buildStacks } from "../lib/app.js";
import { readConfig } from "../lib/config.js";
import type { AirPrompterIds } from "../lib/desk-stack.js";
import type { Pins } from "../lib/shared-host-names.js";

export const CONTEXT = {
  account: "111122223333",
  domain: "zudocs.com",
  regions: { site: "us-east-1", sharedHost: "eu-west-1", fleet: "ap-southeast-1" },
  github: { owner: "airprompter", ownerId: 295734781, repo: "zudocs", repoId: 1375253396, branch: "main" },
  budget: { monthlyUsd: 30, alertUsd: 50 },
  mail: { inboundRegion: "us-east-1", dkimTokens: ["a".repeat(32), "b".repeat(32), "c".repeat(32)] },
};
const here = fileURLToPath(new URL(".", import.meta.url));
export const FLAGS = Object.fromEntries(Object.entries((JSON.parse(readFileSync(join(here, "..", "cdk.json"), "utf8")) as { context: Record<string, unknown> }).context).filter(([k]) => k.startsWith("@aws-cdk/")));
export const IDS: AirPrompterIds = { baseUrl: "https://api-dev.airprompter.com", hostedEnvironment: "dev", rootUrl: "https://edge.example/roots/dev/root.json", edgePointerUrl: "https://edge.example/g/tok/generation.json", organizationId: "org-1", agentId: "agent_x", environment: "dev", rootJwk: JSON.stringify({ kty: "EC", crv: "P-256", x: "x", y: "y", kid: "k" }) };
export const PINS: Pins = { cli: { tag: "cli/v0.1.0", asset: "airprompter-linux-arm64", sha256: "f".repeat(64), url: "https://github.com/airprompter/airprompter-agent-sdk/releases/download/cli/v0.1.0/airprompter-linux-arm64" }, pythonSdk: { tag: "sdk-python/v0.2.14", commit: "0".repeat(40), repo: "https://github.com/airprompter/airprompter-agent-sdk", packages: ["core", "sync", "telemetry", "runtime", "agent"] }, ami: { name: "al2023-fixture", "eu-west-1": "ami-0535b4996339a5410" } };

/** Stand-ins for the built artefacts: the stacks only need the directories to exist. */
export function fixtures(): { deskApi: string; deskSite: string; euHostBundle: string; wire: string } {
  const dir = (name: string, file: string, text: string) => {
    const path = mkdtempSync(join(tmpdir(), `zudocs-${name}-`));
    writeFileSync(join(path, file), text);
    return path;
  };
  return {
    deskApi: dir("desk-api", "index.mjs", "export const handler = async () => ({ statusCode: 200 });\n"),
    deskSite: dir("desk-site", "index.html", "<!doctype html><title>fixture</title>\n"),
    euHostBundle: dir("eu-host-bundle", "worker.mjs", "// fixture\n"),
    wire: dir("wire", "index.mjs", "export const handler = async () => ({});\n"),
  };
}

export function synthAll(email = "owner@example.test", context: Record<string, unknown> = {}) {
  const app = new cdk.App({ context: { ...FLAGS, ...CONTEXT, ...context } });
  const config = readConfig(app.node, { BUDGET_EMAIL: email });
  const stacks = buildStacks(app, config, { assets: fixtures(), airprompter: IDS, pins: PINS });
  // Every stack is on the tree before the first synth: a template after a synth is a modified tree.
  return { dns: Template.fromStack(stacks.dns), site: Template.fromStack(stacks.site), ci: Template.fromStack(stacks.ci), desk: Template.fromStack(stacks.desk), sharedHost: Template.fromStack(stacks.sharedHost), stacks, app, config };
}

export type Resources = Record<string, { Properties: Record<string, any> }>;
export const statementsOf = (template: Template): Array<{ Action: unknown; Resource: unknown; Condition?: Record<string, unknown>; Effect: string; Sid?: string }> =>
  Object.values(template.findResources("AWS::IAM::Policy") as Resources).flatMap((p) => p.Properties.PolicyDocument.Statement);
export const actionsOf = (st: { Action: unknown }): string[] => (Array.isArray(st.Action) ? st.Action : [st.Action]) as string[];
