/**
 * The puller's configuration, read once from its environment and validated: the exchange bucket, the releases
 * table, the desk's status and events tables (in their own region), the NAME of the SSM parameter that holds the
 * Agent key (never the key — the stack's tests pin that no value-shaped variable exists), the AirPrompter
 * identifiers and the pinned root, the host ids, the schedule's interval. A missing name is an error that says
 * which, so a misdeployed function fails its first tick loudly.
 *
 * @example
 * ```ts
 * const env = readPullerEnv(process.env);   // throws "puller env: EXCHANGE_BUCKET is missing"
 * env.agentKeyParameter;                    // "/zudocs/dev/agent-key" — a name; the value is read from SSM at cold start
 * ```
 */

export interface PullerEnv {
  readonly exchangeBucket: string;
  readonly releasesTable: string;
  readonly statusTable: string;
  readonly eventsTable: string;
  readonly tablesRegion: string;
  readonly region: string;
  readonly agentKeyParameter: string;
  readonly airprompter: {
    readonly baseUrl: string;
    readonly organizationId: string;
    readonly agentId: string;
    readonly environment: "dev" | "staging" | "prod";
    readonly hostedEnvironment: "dev" | "staging" | "prod";
    readonly rootUrl: string;
    readonly edgePointerUrl: string | null;
    readonly rootJwk: string;
  };
  readonly hostId: string;
  readonly airgapHostId: string;
  /** The schedule's interval: the floor between pulls, and what the backoff stretches from. */
  readonly pullIntervalSeconds: number;
  readonly functionName: string;
}

const need = (env: NodeJS.ProcessEnv, name: string): string => {
  const value = env[name];
  if (!value || !value.trim()) throw new Error(`puller env: ${name} is missing`);
  return value.trim();
};

const target = (value: string, name: string): "dev" | "staging" | "prod" => {
  if (value !== "dev" && value !== "staging" && value !== "prod") throw new Error(`puller env: ${name} must be dev, staging or prod`);
  return value;
};

export function readPullerEnv(env: NodeJS.ProcessEnv = process.env): PullerEnv {
  if (env.AIRPROMPTER_AGENT_KEY) throw new Error("puller env: AIRPROMPTER_AGENT_KEY is set in the environment; the key is read from SSM by name, never from a variable");
  const parameter = need(env, "AGENT_KEY_PARAMETER");
  if (!parameter.startsWith("/")) throw new Error("puller env: AGENT_KEY_PARAMETER is an SSM parameter name (it starts with /), never a key");
  const interval = Number(env.PULL_INTERVAL_SECONDS ?? "300");
  if (!Number.isInteger(interval) || interval < 30) throw new Error("puller env: PULL_INTERVAL_SECONDS must be an integer of at least 30");
  const pointer = env.AIRPROMPTER_EDGE_POINTER_URL?.trim() || null;
  return Object.freeze({
    exchangeBucket: need(env, "EXCHANGE_BUCKET"),
    releasesTable: need(env, "RELEASES_TABLE"),
    statusTable: need(env, "STATUS_TABLE"),
    eventsTable: need(env, "EVENTS_TABLE"),
    tablesRegion: need(env, "TABLES_REGION"),
    region: env.AWS_REGION?.trim() || "ap-southeast-1",
    agentKeyParameter: parameter,
    airprompter: Object.freeze({
      baseUrl: need(env, "AIRPROMPTER_BASE_URL"),
      organizationId: need(env, "AIRPROMPTER_ORGANIZATION_ID"),
      agentId: need(env, "AIRPROMPTER_AGENT_ID"),
      environment: target(need(env, "AIRPROMPTER_ENVIRONMENT"), "AIRPROMPTER_ENVIRONMENT"),
      hostedEnvironment: target(need(env, "AIRPROMPTER_HOSTED_ENVIRONMENT"), "AIRPROMPTER_HOSTED_ENVIRONMENT"),
      rootUrl: need(env, "AIRPROMPTER_ROOT_URL"),
      edgePointerUrl: pointer,
      rootJwk: need(env, "AIRPROMPTER_ROOT_JWK"),
    }),
    hostId: env.HOST_ID?.trim() || "ap-southeast-1/puller",
    airgapHostId: env.AIRGAP_HOST_ID?.trim() || "ap-southeast-1/airgap",
    pullIntervalSeconds: interval,
    functionName: env.AWS_LAMBDA_FUNCTION_NAME?.trim() || "",
  });
}
