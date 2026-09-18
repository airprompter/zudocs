/**
 * The air-gapped runtime's configuration, from `/etc/airprompter/zudocs.env` (systemd's EnvironmentFile; rendered by
 * the build from the committed identifiers — the exchange bucket, the releases table, the AirPrompter ids, the
 * paths, the cadences). No key of any kind is in it: this host has no Agent key at all (it is offline), and its
 * distribution private key is a file `airprompter keygen` wrote, named here by PATH. A base URL is refused too —
 * nothing on this host is configured to call home, and a rendered file that names one is a mistake worth stopping.
 *
 * @example
 * ```ts
 * const env = readAirgapEnv(process.env);   // throws "airgap env: EXCHANGE_BUCKET is missing"
 * env.distributionKeyPath;                  // "/var/lib/airprompter/keys/airgap.key.json" — 0600, born on this host, never leaves
 * ```
 */

export interface AirgapEnv {
  readonly hostId: string;
  readonly region: string;
  readonly exchangeBucket: string;
  readonly releasesTable: string;
  readonly airprompter: {
    readonly organizationId: string;
    readonly agentId: string;
    readonly environment: "dev" | "staging" | "prod";
    readonly hostedEnvironment: "dev" | "staging" | "prod";
    readonly rootJwkPath: string;
  };
  readonly stateDir: string;
  readonly distributionKeyPath: string;
  readonly vendoredBundlePath: string;
  /** The export timer's last result (`host/bin/zudocs-airgap-export` writes it) and the boot probe's result. */
  readonly exportStatePath: string;
  readonly probePath: string;
  readonly applyIntervalSeconds: number;
  readonly statusIntervalSeconds: number;
  readonly renderIntervalSeconds: number;
}

const need = (env: NodeJS.ProcessEnv, name: string): string => {
  const value = env[name];
  if (!value || !value.trim()) throw new Error(`airgap env: ${name} is missing`);
  return value.trim();
};

const target = (value: string, name: string): "dev" | "staging" | "prod" => {
  if (value !== "dev" && value !== "staging" && value !== "prod") throw new Error(`airgap env: ${name} must be dev, staging or prod`);
  return value;
};

const seconds = (env: NodeJS.ProcessEnv, name: string, fallback: number, min: number): number => {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) throw new Error(`airgap env: ${name} must be an integer of at least ${min}`);
  return value;
};

export function readAirgapEnv(env: NodeJS.ProcessEnv = process.env): AirgapEnv {
  if (env.AIRPROMPTER_AGENT_KEY) throw new Error("airgap env: AIRPROMPTER_AGENT_KEY is set; this host is offline and holds no Agent key");
  if (env.AIRPROMPTER_BASE_URL) throw new Error("airgap env: AIRPROMPTER_BASE_URL is set; nothing on this host calls home");
  return Object.freeze({
    hostId: need(env, "ZUDOCS_HOST_ID"),
    region: need(env, "ZUDOCS_REGION"),
    exchangeBucket: need(env, "EXCHANGE_BUCKET"),
    releasesTable: need(env, "RELEASES_TABLE"),
    airprompter: Object.freeze({
      organizationId: need(env, "AIRPROMPTER_ORG"),
      agentId: need(env, "AIRPROMPTER_AGENT"),
      environment: target(need(env, "AIRPROMPTER_ENVIRONMENT"), "AIRPROMPTER_ENVIRONMENT"),
      hostedEnvironment: target(need(env, "AIRPROMPTER_HOSTED_ENVIRONMENT"), "AIRPROMPTER_HOSTED_ENVIRONMENT"),
      rootJwkPath: need(env, "AIRPROMPTER_ROOT_JWK_PATH"),
    }),
    stateDir: need(env, "AIRPROMPTER_STATE_DIR"),
    distributionKeyPath: need(env, "ZUDOCS_DISTRIBUTION_KEY_PATH"),
    vendoredBundlePath: need(env, "ZUDOCS_VENDORED_BUNDLE_PATH"),
    exportStatePath: need(env, "ZUDOCS_EXPORT_STATE_PATH"),
    probePath: need(env, "ZUDOCS_PROBE_PATH"),
    applyIntervalSeconds: seconds(env, "ZUDOCS_APPLY_INTERVAL_SECONDS", 30, 5),
    statusIntervalSeconds: seconds(env, "ZUDOCS_STATUS_INTERVAL_SECONDS", 60, 10),
    renderIntervalSeconds: seconds(env, "ZUDOCS_RENDER_INTERVAL_SECONDS", 120, 15),
  });
}
