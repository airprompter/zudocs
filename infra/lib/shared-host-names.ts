/**
 * The fixed names the eu-west host stack and the desk stack agree on without a cross-region reference: the host's
 * instance role (the Budgets action attaches the Bedrock deny policy to it by name), the wire function (the
 * presenter's cut / restore invoke it by ARN), the host's id in the status table, the log group — and the pins of
 * what the host installs (`services/eu-host/pins.json`: the released CLI's linux-arm64 digest, the Python SDK's
 * commit), read here so the stack and the build agree on one file.
 *
 * @example
 * ```ts
 * import { EU_HOST_ROLE_NAME, WIRE_FUNCTION_NAME, readPins } from "./shared-host-names.js";
 * `arn:aws:lambda:eu-west-1:${account}:function:${WIRE_FUNCTION_NAME}`;
 * readPins().cli.sha256;   // the digest the boot script checks before the CLI is executable
 * readPins().ami["eu-west-1"];   // the pinned AL2023 arm64 image
 * ```
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The instance role's fixed name (IAM is global, so the desk stack's Budgets action can name it). */
export const EU_HOST_ROLE_NAME = "zudocs-eu-host";
/** The wire function's fixed name (the desk stack invokes it across regions by ARN). */
export const WIRE_FUNCTION_NAME = "zudocs-wire";
/** The host's row in the status table and its name on every timeline event. */
export const EU_HOST_ID = "eu-west-1/ec2";
/** The log group the host's units ship to (seven-day retention). */
export const EU_HOST_LOG_GROUP = "/zudocs/eu-host";
/** Minutes a cut wire stays cut before the rule restores it, whatever the presenter forgot. */
export const WIRE_CUT_MAX_MINUTES = 15;

export interface Pins {
  readonly cli: { readonly tag: string; readonly asset: string; readonly sha256: string; readonly url: string };
  readonly pythonSdk: { readonly tag: string; readonly commit: string; readonly repo: string; readonly packages: readonly string[] };
  /** The AL2023 arm64 image per region, pinned: a resolved-at-deploy image would replace the instance on every refresh. */
  readonly ami: { readonly name: string; readonly [region: string]: string };
}

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");

/** `services/eu-host/pins.json`, checked: a 64-hex digest, a 40-hex commit, an https release URL. */
export function readPins(root = repoRoot): Pins {
  const pins = JSON.parse(readFileSync(join(root, "services", "eu-host", "pins.json"), "utf8")) as Pins;
  if (!/^[0-9a-f]{64}$/.test(pins.cli?.sha256 ?? "")) throw new Error("pins.json: cli.sha256 is not a sha256 digest");
  if (!/^https:\/\/github\.com\/airprompter\/airprompter-agent-sdk\/releases\/download\/cli\/v[0-9.]+\/airprompter-linux-arm64$/.test(pins.cli.url)) throw new Error("pins.json: cli.url is not the release's linux-arm64 asset");
  if (!/^[0-9a-f]{40}$/.test(pins.pythonSdk?.commit ?? "")) throw new Error("pins.json: pythonSdk.commit is not a 40-character commit");
  if (!Array.isArray(pins.pythonSdk.packages) || pins.pythonSdk.packages.length === 0) throw new Error("pins.json: pythonSdk.packages is empty");
  if (!pins.ami || !Object.entries(pins.ami).some(([region, id]) => /^[a-z]{2}-[a-z]+-\d$/.test(region) && /^ami-[0-9a-f]{8,17}$/.test(id))) throw new Error("pins.json: ami names no region → ami-… pin");
  return pins;
}
