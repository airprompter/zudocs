/**
 * What the build renders for the air-gapped host from the committed configuration: `zudocs.env` — the host id, the
 * region, the exchange bucket and the releases table (the fixed names `infra/lib/fleet-names.ts` decides, computed
 * here from the account in the environment or a placeholder the boot script replaces), the AirPrompter identifiers,
 * the paths and the cadences for the units. Never a key, never a base URL: this host is offline, and a value or a
 * name that looks like either is refused. Pure over its inputs, so the tests pin the shape.
 *
 * @example
 * ```js
 * renderAirgapEnv(config, cdkContext);   // "ZUDOCS_HOST_ID=ap-southeast-1/airgap\nEXCHANGE_BUCKET=@EXCHANGE_BUCKET@\n…"
 * ```
 */

/** The host's environment file. The bucket name is account-qualified and the account is not in git: the boot script fills the placeholder. */
export function renderAirgapEnv(config, cdkContext, env = process.env) {
  const pick = (key, envName) => {
    const value = env[envName] ?? config[key];
    if (typeof value !== "string" || !value.trim()) throw new Error(`airgap build: ${key} is missing from airprompter.config.json`);
    return value.trim();
  };
  const region = cdkContext.regions?.fleet;
  if (!region) throw new Error("airgap build: infra/cdk.json names no regions.fleet");
  const lines = {
    ZUDOCS_HOST_ID: `${region}/airgap`,
    ZUDOCS_REGION: region,
    EXCHANGE_BUCKET: "@EXCHANGE_BUCKET@",
    RELEASES_TABLE: "zudocs-agent-releases",
    AIRPROMPTER_STATE_DIR: "/var/lib/airprompter",
    AIRPROMPTER_ROOT_JWK_PATH: "/etc/airprompter/root.jwk.json",
    ZUDOCS_DISTRIBUTION_KEY_PATH: "/var/lib/airprompter/keys/airgap.key.json",
    ZUDOCS_VENDORED_BUNDLE_PATH: "/var/lib/airprompter/vendored.apbundle",
    ZUDOCS_EXPORT_STATE_PATH: "/var/lib/zudocs/export/last.json",
    ZUDOCS_PROBE_PATH: "/var/lib/zudocs/probe.json",
    ZUDOCS_APPLY_INTERVAL_SECONDS: "30",
    ZUDOCS_STATUS_INTERVAL_SECONDS: "60",
    ZUDOCS_RENDER_INTERVAL_SECONDS: "120",
    AIRPROMPTER_ORG: pick("organizationId", "AIRPROMPTER_ORGANIZATION_ID"),
    AIRPROMPTER_AGENT: pick("agentId", "AIRPROMPTER_AGENT_ID"),
    AIRPROMPTER_ENVIRONMENT: pick("environment", "AIRPROMPTER_ENVIRONMENT"),
    AIRPROMPTER_HOSTED_ENVIRONMENT: pick("hostedEnvironment", "AIRPROMPTER_HOSTED_ENVIRONMENT"),
  };
  for (const [name, value] of Object.entries(lines)) {
    if (/KEY$|SECRET|TOKEN|PASSWORD|BASE_URL/.test(name) && !/_PATH$/.test(name)) throw new Error(`airgap build: ${name} looks like a secret's slot or a way home`);
    if (/^apa_|^apk_|^eyJ|^https?:/.test(value)) throw new Error(`airgap build: ${name} holds a value that looks like a key or a URL`);
    if (/[\s"'\\]/.test(value)) throw new Error(`airgap build: ${name} holds a character systemd's EnvironmentFile would misread`);
  }
  return `# The Zudocs air-gapped host: identifiers, the exchange, paths, cadences. Rendered by services/airgap/build.mjs;\n# never a key and never a base URL (this host is offline; its distribution private key is a file keygen wrote, named by path).\n${Object.entries(lines).map(([k, v]) => `${k}=${v}`).join("\n")}\n`;
}
