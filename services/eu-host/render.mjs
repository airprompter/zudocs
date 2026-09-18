/**
 * What the build renders for the host from the committed configuration: `zudocs.env` (identifiers, table names,
 * regions and cadences for the units — never a key: a value or a name that looks like one is refused) and the
 * Python worker's `requirements.txt` (the SDK's five distributions by the pinned commit, LiteLLM, boto3). Pure over
 * their inputs, so the tests pin the shape.
 *
 * @example
 * ```js
 * renderHostEnv(config, cdkContext);          // "ZUDOCS_HOST_ID=eu-west-1/ec2\nZUDOCS_REGION=eu-west-1\n…EXCHANGE_BUCKET=@EXCHANGE_BUCKET@…" (the boot fills the bucket)
 * renderRequirements(pins);                    // "airprompter-agent-core @ git+https://…@<commit>#subdirectory=…"
 * ```
 */

/** The host's identifiers — from the committed config, with the same environment overrides the scripts honour. */
export function renderHostEnv(config, cdkContext, env = process.env) {
  const pick = (key, envName) => {
    const value = env[envName] ?? config[key];
    if (typeof value !== "string" || !value.trim()) throw new Error(`eu-host build: ${key} is missing from airprompter.config.json`);
    return value.trim();
  };
  const region = cdkContext.regions?.sharedHost;
  const tablesRegion = cdkContext.regions?.site;
  const fleetRegion = cdkContext.regions?.fleet;
  if (!region || !tablesRegion || !fleetRegion) throw new Error("eu-host build: infra/cdk.json names no regions.sharedHost / regions.site / regions.fleet");
  const environment = pick("environment", "AIRPROMPTER_ENVIRONMENT");
  const pointer = env.AIRPROMPTER_EDGE_POINTER_URL ?? config.edgePointerUrl ?? "";
  if (typeof pointer !== "string" || !pointer.trim()) throw new Error("eu-host build: edgePointerUrl is missing (the daemon idles on the environment's pointer)");
  const lines = {
    ZUDOCS_HOST_ID: `${region}/ec2`,
    ZUDOCS_REGION: region,
    ZUDOCS_TABLES_REGION: tablesRegion,
    ZUDOCS_BEDROCK_REGION: tablesRegion,
    // The exchange bucket (account-qualified, filled by the boot script from the stack) and its region: the import timer reads the air-gapped host's exports there.
    EXCHANGE_BUCKET: "@EXCHANGE_BUCKET@",
    ZUDOCS_EXCHANGE_REGION: fleetRegion,
    ZUDOCS_IMPORT_DIR: "/var/lib/zudocs/import",
    ZUDOCS_AGENT_KEY_PARAMETER: `/zudocs/${environment}/agent-key`,
    ZUDOCS_DAILY_RUN_CAP: "2000",
    ZUDOCS_TICKET_INTERVAL_SECONDS: "600",
    ZUDOCS_PY_TICKET_INTERVAL_SECONDS: "1200",
    ZUDOCS_STATUS_INTERVAL_SECONDS: "30",
    TICKETS_TABLE: "zudocs-desk-tickets",
    CUSTOMERS_TABLE: "zudocs-desk-customers",
    RUNS_TABLE: "zudocs-desk-runs",
    FEEDBACK_TABLE: "zudocs-desk-feedback",
    STATUS_TABLE: "zudocs-desk-status",
    EVENTS_TABLE: "zudocs-desk-events",
    COUNTERS_TABLE: "zudocs-desk-counters",
    APPROVALS_TABLE: "zudocs-desk-approvals",
    AIRPROMPTER_STATE_DIR: "/var/lib/airprompter",
    AIRPROMPTER_ROOT_JWK_PATH: "/etc/airprompter/root.jwk.json",
    AIRPROMPTER_ORG: pick("organizationId", "AIRPROMPTER_ORGANIZATION_ID"),
    AIRPROMPTER_AGENT: pick("agentId", "AIRPROMPTER_AGENT_ID"),
    AIRPROMPTER_ENVIRONMENT: environment,
    AIRPROMPTER_HOSTED_ENVIRONMENT: pick("hostedEnvironment", "AIRPROMPTER_HOSTED_ENVIRONMENT"),
    AIRPROMPTER_BASE_URL: pick("baseUrl", "AIRPROMPTER_BASE_URL"),
    AIRPROMPTER_ROOT_URL: pick("rootUrl", "AIRPROMPTER_ROOT_URL"),
    AIRPROMPTER_EDGE_POINTER_URL: pointer.trim(),
  };
  for (const [name, value] of Object.entries(lines)) {
    if (/KEY$|SECRET|TOKEN|PASSWORD/.test(name) && name !== "ZUDOCS_AGENT_KEY_PARAMETER") throw new Error(`eu-host build: ${name} looks like a secret's slot`);
    if (/^apa_|^apk_|^eyJ/.test(value)) throw new Error(`eu-host build: ${name} holds a value that looks like a key`);
    if (/[\s"'\\]/.test(value)) throw new Error(`eu-host build: ${name} holds a character systemd's EnvironmentFile would misread`);
  }
  return `# The Zudocs eu-west host: identifiers, table names, regions, cadences. Rendered by services/eu-host/build.mjs;\n# never a key (the Agent key is in airprompterd.env, root:root 0600, written from SSM by zudocs-agent-key).\n${Object.entries(lines).map(([k, v]) => `${k}=${v}`).join("\n")}\n`;
}

/** The Python worker's requirements: the SDK's five distributions by the pinned commit, LiteLLM, boto3. */
export function renderRequirements(pins) {
  if (!/^[0-9a-f]{40}$/.test(pins.pythonSdk?.commit ?? "")) throw new Error("eu-host build: pins.pythonSdk.commit is not a 40-character commit");
  const at = `git+${pins.pythonSdk.repo}@${pins.pythonSdk.commit}`;
  const lines = pins.pythonSdk.packages.map((name) => {
    const dist = name === "agent" ? "airprompter-agent[litellm]" : name === "runtime" ? "airprompter-agent-runtime[litellm]" : `airprompter-agent-${name}`;
    return `${dist} @ ${at}#subdirectory=sdk-python/packages/${name}`;
  });
  return `# Rendered from services/eu-host/pins.json: the public Python SDK at ${pins.pythonSdk.tag} (${pins.pythonSdk.commit.slice(0, 12)}) — PyPI does not carry it yet.\n${lines.join("\n")}\nboto3>=1.34\n`;
}
