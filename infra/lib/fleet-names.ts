/**
 * The fixed names the ap-southeast-1 stacks, the desk stack and the eu-west host agree on without a cross-region
 * reference: the exchange bucket (account-qualified — bucket names are global), the releases table, the nudge queue,
 * the puller function, the two host ids in the status table, the air-gapped host's role — and the layout of the
 * exchange bucket, which is the contract between the puller (writes releases, reads the host's public key and its
 * status), the air-gapped host (reads releases, writes its key's public half, its status and its telemetry
 * exports) and the eu-west import cron (reads the exports). The pins of what the air-gapped host installs
 * (`services/airgap/pins.json`: the Node runtime's digest, the AMI per region) are read here too; the CLI's digest
 * is the fleet's one pin in `services/eu-host/pins.json`.
 *
 * @example
 * ```ts
 * import { EXCHANGE, exchangeBucketName, NUDGE_QUEUE_NAME, readAirgapPins } from "./fleet-names.js";
 * exchangeBucketName("111122223333");           // "zudocs-exchange-111122223333"
 * `${EXCHANGE.releasesPrefix}${generation}-${keyId.slice(0, 8)}.apbundle`;   // where the puller writes a sealed bundle
 * readAirgapPins().node.sha256;                  // the digest the boot checks before Node is extracted
 * ```
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** `zudocs-exchange-<account>`: the fleet's own artefact store in ap-southeast-1 (versioned, private, SSE-S3). */
export const exchangeBucketName = (account: string): string => `zudocs-exchange-${account}`;
/** One row per generation the puller pulled (and the puller's own state row); the air-gapped host reads the newest. */
export const RELEASES_TABLE_NAME = "zudocs-agent-releases";
/** The change-notification placeholder: the desk posts, the puller pulls with `skipPointer`. */
export const NUDGE_QUEUE_NAME = "zudocs-nudge";
export const NUDGE_DLQ_NAME = "zudocs-nudge-dlq";
export const PULLER_FUNCTION_NAME = "zudocs-puller";
export const PULLER_HOST_ID = "ap-southeast-1/puller";
export const AIRGAP_HOST_ID = "ap-southeast-1/airgap";
/** The air-gapped instance role's fixed name (no Bedrock: the Budgets action never needs to name it). */
export const AIRGAP_ROLE_NAME = "zudocs-airgap-host";
/** How many minutes the puller's schedule ticks at; a `--context demo=true` synth makes it one. */
export const PULL_MINUTES = 5;
export const PULL_MINUTES_DEMO = 1;
/** How often the desk Lambda is invoked to write its status row between runs (the phase-4 follow-up). */
export const DESK_STATUS_TICK_MINUTES = 5;

/**
 * The exchange bucket's layout. Everything the puller writes is under `releases/` and `latest.json`; everything the
 * air-gapped host writes is under `keys/` (its public half only — the role can put exactly one key there),
 * `status/` and `telemetry/`; `tools/` is what `npm run airgap:up` stages for the first boot (Node and the CLI,
 * verified on the host against the pinned digests before either runs).
 */
export const EXCHANGE = Object.freeze({
  releasesPrefix: "releases/",
  latest: "latest.json",
  /** The air-gapped host's distribution PUBLIC key, as `airprompter keygen` wrote it (kind airprompter-distribution-public-key). */
  publicKey: "keys/airgap.distribution.pub.json",
  status: "status/airgap.json",
  telemetryPrefix: "telemetry/",
  toolsPrefix: "tools/",
});

export interface AirgapPins {
  readonly node: { readonly version: string; readonly asset: string; readonly sha256: string; readonly url: string };
  readonly ami: { readonly name: string; readonly [region: string]: string };
}

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");

/** `services/airgap/pins.json`, checked: a Node 22 linux-arm64 tarball from nodejs.org with a 64-hex digest, an AMI per region. */
export function readAirgapPins(root = repoRoot): AirgapPins {
  const pins = JSON.parse(readFileSync(join(root, "services", "airgap", "pins.json"), "utf8")) as AirgapPins;
  if (!/^v22\.\d+\.\d+$/.test(pins.node?.version ?? "")) throw new Error("airgap pins.json: node.version is not a v22.x.y version");
  if (!/^[0-9a-f]{64}$/.test(pins.node?.sha256 ?? "")) throw new Error("airgap pins.json: node.sha256 is not a sha256 digest");
  if (pins.node.url !== `https://nodejs.org/dist/${pins.node.version}/node-${pins.node.version}-linux-arm64.tar.gz` || pins.node.asset !== `node-${pins.node.version}-linux-arm64.tar.gz`) throw new Error("airgap pins.json: node.url / node.asset do not name the version's linux-arm64 gzip tarball on nodejs.org");
  if (!pins.ami || !Object.entries(pins.ami).some(([region, id]) => /^[a-z]{2}-[a-z]+-\d$/.test(region) && /^ami-[0-9a-f]{8,17}$/.test(id))) throw new Error("airgap pins.json: ami names no region → ami-… pin");
  return pins;
}
