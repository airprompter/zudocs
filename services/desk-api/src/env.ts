/**
 * The Lambda's configuration, read once from its environment and validated: table names, the KMS key, the NAME
 * of the SSM parameter that holds the Agent key (never the key — the stack's tests pin that no value-shaped
 * variable exists), the AirPrompter identifiers, the daily run cap. A missing name is an error that says which,
 * so a misdeployed function fails its first request loudly instead of pretending.
 *
 * @example
 * ```ts
 * const env = readEnv(process.env);   // throws "env: TICKETS_TABLE is missing" on a bad deploy
 * env.agentKeyParameter;              // "/zudocs/dev/agent-key" — a name; the value is read from SSM at cold start
 * ```
 */

export interface DeskEnv {
  readonly tables: {
    readonly tickets: string;
    readonly customers: string;
    readonly runs: string;
    readonly feedback: string;
    readonly status: string;
    readonly events: string;
    readonly counters: string;
    readonly approvals: string;
  };
  readonly kmsKeyId: string;
  /** The eu-west wire function (`zudocs-wire`) the presenter's cut / restore invoke; empty until that stack exists. */
  readonly wireFunctionArn: string;
  /** The fleet's nudge queue in ap-southeast-1 (`zudocs-nudge`) the presenter posts to; empty until that stack exists. */
  readonly nudgeQueueUrl: string;
  /** The eu-west power function (`zudocs-power`, phase 8) the presenter's sleep / wake invoke; empty until that stack exists. */
  readonly powerFunctionArn: string;
  /** The eu-west demo-mode parameter NAME (a String, `hostPower.ts`); empty when the deployment names none. */
  readonly demoModeParameter: string;
  /** The SSM SecureString parameter NAME the Agent key is read from at cold start. */
  readonly agentKeyParameter: string;
  /**
   * Hosted staging (phase 6): the SSM SecureString NAME of the staging run key, the hosted run route's origin (the
   * `AgentRunUrl` of AirPrompter's execution stack, an identifier) and the environment the key is bound to. Empty when
   * the deployment names none: the desk then says hosted staging is not configured instead of pretending.
   */
  readonly hosted: { readonly runKeyParameter: string; readonly runUrl: string; readonly target: "dev" | "staging" | "prod" };
  /** The eu-west host's region and the Name tag its instance carries: the presenter's one-click CLI runs there through Run Command. */
  readonly euHost: { readonly region: string; readonly nameTag: string };
  readonly airprompter: {
    readonly baseUrl: string;
    readonly organizationId: string;
    readonly agentId: string;
    readonly environment: string;
    readonly hostedEnvironment: string;
    readonly rootUrl: string;
    /** The pinned root JWK as one JSON string (from `keys/<hosted>.root.jwk.json` at synth). */
    readonly rootJwk: string;
  };
  /** Runs per UTC day this host allows before it refuses (429), whatever the caller asks. */
  readonly dailyRunCap: number;
  /** Bumped by the reset script: a new value is a new state directory, so new containers start from an empty store. */
  readonly stateEpoch: string;
  readonly stateDir: string;
  readonly hostId: string;
  readonly region: string;
  readonly emfNamespace: string;
  /** The function's own name, for the replay self-invocation. */
  readonly functionName: string;
  readonly heartbeatSeconds: number;
}

const need = (env: NodeJS.ProcessEnv, name: string): string => {
  const value = env[name];
  if (!value || !value.trim()) throw new Error(`env: ${name} is missing`);
  return value.trim();
};

export function readEnv(env: NodeJS.ProcessEnv = process.env): DeskEnv {
  const cap = Number(need(env, "DAILY_RUN_CAP"));
  if (!Number.isInteger(cap) || cap < 1) throw new Error("env: DAILY_RUN_CAP must be a positive integer");
  const parameter = need(env, "AGENT_KEY_PARAMETER");
  if (!parameter.startsWith("/")) throw new Error("env: AGENT_KEY_PARAMETER is an SSM parameter name (it starts with /), never a key");
  const runKeyParameter = env.RUN_KEY_PARAMETER?.trim() || "";
  if (runKeyParameter && !runKeyParameter.startsWith("/")) throw new Error("env: RUN_KEY_PARAMETER is an SSM parameter name (it starts with /), never a key");
  if (runKeyParameter.startsWith("apr_") || runKeyParameter.startsWith("apa_")) throw new Error("env: RUN_KEY_PARAMETER looks like a key, not a parameter name");
  const runUrl = env.AIRPROMPTER_HOSTED_RUN_URL?.trim() || "";
  if (runUrl && !/^https:\/\/[^\s/]+$/.test(runUrl)) throw new Error("env: AIRPROMPTER_HOSTED_RUN_URL is an https origin with no path");
  const hostedTarget = env.AIRPROMPTER_HOSTED_TARGET?.trim() || "staging";
  if (!["dev", "staging", "prod"].includes(hostedTarget)) throw new Error("env: AIRPROMPTER_HOSTED_TARGET must be dev, staging or prod");
  const demoModeParameter = env.DEMO_MODE_PARAMETER?.trim() || "";
  if (demoModeParameter && !demoModeParameter.startsWith("/")) throw new Error("env: DEMO_MODE_PARAMETER is an SSM parameter name (it starts with /)");
  const stateEpoch = need(env, "STATE_EPOCH");
  const heartbeat = Number(env.HEARTBEAT_SECONDS ?? "60");
  return Object.freeze({
    tables: Object.freeze({
      tickets: need(env, "TICKETS_TABLE"),
      customers: need(env, "CUSTOMERS_TABLE"),
      runs: need(env, "RUNS_TABLE"),
      feedback: need(env, "FEEDBACK_TABLE"),
      status: need(env, "STATUS_TABLE"),
      events: need(env, "EVENTS_TABLE"),
      counters: need(env, "COUNTERS_TABLE"),
      approvals: need(env, "APPROVALS_TABLE"),
    }),
    kmsKeyId: need(env, "KMS_KEY_ID"),
    wireFunctionArn: env.WIRE_FUNCTION_ARN?.trim() || "",
    nudgeQueueUrl: env.NUDGE_QUEUE_URL?.trim() || "",
    powerFunctionArn: env.POWER_FUNCTION_ARN?.trim() || "",
    demoModeParameter: demoModeParameter,
    agentKeyParameter: parameter,
    hosted: Object.freeze({ runKeyParameter, runUrl, target: hostedTarget as "dev" | "staging" | "prod" }),
    euHost: Object.freeze({ region: env.EU_HOST_REGION?.trim() || "eu-west-1", nameTag: env.EU_HOST_NAME_TAG?.trim() || "zudocs-eu-host" }),
    airprompter: Object.freeze({
      baseUrl: need(env, "AIRPROMPTER_BASE_URL"),
      organizationId: need(env, "AIRPROMPTER_ORGANIZATION_ID"),
      agentId: need(env, "AIRPROMPTER_AGENT_ID"),
      environment: need(env, "AIRPROMPTER_ENVIRONMENT"),
      hostedEnvironment: need(env, "AIRPROMPTER_HOSTED_ENVIRONMENT"),
      rootUrl: need(env, "AIRPROMPTER_ROOT_URL"),
      rootJwk: need(env, "AIRPROMPTER_ROOT_JWK"),
    }),
    dailyRunCap: cap,
    stateEpoch,
    stateDir: `/tmp/airprompter/${stateEpoch}`,
    hostId: env.HOST_ID?.trim() || "us-east-1/lambda",
    region: env.AWS_REGION?.trim() || "us-east-1",
    emfNamespace: env.EMF_NAMESPACE?.trim() || "Zudocs/Desk",
    functionName: env.AWS_LAMBDA_FUNCTION_NAME?.trim() || "",
    heartbeatSeconds: Number.isFinite(heartbeat) && heartbeat >= 30 ? heartbeat : 60,
  });
}
