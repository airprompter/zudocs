/**
 * The worker's configuration, from `/etc/airprompter/zudocs.env` (systemd's EnvironmentFile; identifiers, table
 * names, regions, cadences — never a key: the Agent key lives in the daemon's own 0600 file and no worker process
 * has it). A missing name is an error that says which, so a mis-rendered boot fails loudly at the first start.
 *
 * @example
 * ```ts
 * const env = readHostEnv(process.env);   // throws "host env: TICKETS_TABLE is missing"
 * env.stateDir;                           // "/var/lib/airprompter" — the daemon's store; this process attaches, never opens it
 * env.ticketIntervalSeconds;              // 3600 idle; env.demoTicketIntervalSeconds (120) while the demo-mode parameter says on
 * ```
 */
import type { DeskEnv } from "../../desk-api/src/env.js";

export interface HostEnv {
  readonly hostId: string;
  readonly region: string;
  /** The desk's tables live in us-east-1; the worker reaches them by name over a client for that region. */
  readonly tablesRegion: string;
  readonly bedrockRegion: string;
  readonly tables: DeskEnv["tables"];
  readonly stateDir: string;
  readonly airprompter: {
    readonly organizationId: string;
    readonly agentId: string;
    readonly environment: "dev" | "staging" | "prod";
    readonly hostedEnvironment: "dev" | "staging" | "prod";
    readonly rootJwkPath: string;
  };
  readonly dailyRunCap: number;
  /** Seconds between the worker's own ticket runs when idle (a queued ticket runs sooner; demo mode shortens it). */
  readonly ticketIntervalSeconds: number;
  /** Seconds between ticket runs while demo mode is on (`demoMode.ts`). */
  readonly demoTicketIntervalSeconds: number;
  /** The SSM String parameter NAME the demo-mode switch lives in (the host's region); read every `demoModePollSeconds`. */
  readonly demoModeParameter: string;
  readonly demoModePollSeconds: number;
  readonly statusIntervalSeconds: number;
  readonly by: string;
}

const need = (env: NodeJS.ProcessEnv, name: string): string => {
  const value = env[name];
  if (!value || !value.trim()) throw new Error(`host env: ${name} is missing`);
  return value.trim();
};

const target = (value: string, name: string): "dev" | "staging" | "prod" => {
  if (value !== "dev" && value !== "staging" && value !== "prod") throw new Error(`host env: ${name} must be dev, staging or prod`);
  return value;
};

const seconds = (env: NodeJS.ProcessEnv, name: string, fallback: number, min: number): number => {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) throw new Error(`host env: ${name} must be an integer of at least ${min}`);
  return value;
};

const parameterName = (env: NodeJS.ProcessEnv, name: string, fallback: string): string => {
  const raw = env[name]?.trim();
  const value = raw || fallback;
  if (!value.startsWith("/")) throw new Error(`host env: ${name} is an SSM parameter name (it starts with /)`);
  return value;
};

export function readHostEnv(env: NodeJS.ProcessEnv = process.env): HostEnv {
  if (env.AIRPROMPTER_AGENT_KEY) throw new Error("host env: AIRPROMPTER_AGENT_KEY is set in a worker's environment; only the daemon holds the key");
  const cap = Number(env.ZUDOCS_DAILY_RUN_CAP ?? "2000");
  if (!Number.isInteger(cap) || cap < 1) throw new Error("host env: ZUDOCS_DAILY_RUN_CAP must be a positive integer");
  return Object.freeze({
    hostId: need(env, "ZUDOCS_HOST_ID"),
    region: need(env, "ZUDOCS_REGION"),
    tablesRegion: need(env, "ZUDOCS_TABLES_REGION"),
    bedrockRegion: need(env, "ZUDOCS_BEDROCK_REGION"),
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
    stateDir: need(env, "AIRPROMPTER_STATE_DIR"),
    airprompter: Object.freeze({
      organizationId: need(env, "AIRPROMPTER_ORG"),
      agentId: need(env, "AIRPROMPTER_AGENT"),
      environment: target(need(env, "AIRPROMPTER_ENVIRONMENT"), "AIRPROMPTER_ENVIRONMENT"),
      hostedEnvironment: target(need(env, "AIRPROMPTER_HOSTED_ENVIRONMENT"), "AIRPROMPTER_HOSTED_ENVIRONMENT"),
      rootJwkPath: need(env, "AIRPROMPTER_ROOT_JWK_PATH"),
    }),
    dailyRunCap: cap,
    ticketIntervalSeconds: seconds(env, "ZUDOCS_TICKET_INTERVAL_SECONDS", 3600, 30),
    demoTicketIntervalSeconds: seconds(env, "ZUDOCS_DEMO_TICKET_INTERVAL_SECONDS", 120, 30),
    demoModeParameter: parameterName(env, "ZUDOCS_DEMO_MODE_PARAMETER", `/zudocs/${target(need(env, "AIRPROMPTER_ENVIRONMENT"), "AIRPROMPTER_ENVIRONMENT")}/demo-mode`),
    demoModePollSeconds: seconds(env, "ZUDOCS_DEMO_MODE_POLL_SECONDS", 60, 10),
    statusIntervalSeconds: seconds(env, "ZUDOCS_STATUS_INTERVAL_SECONDS", 30, 5),
    by: env.ZUDOCS_WORKER_NAME?.trim() || "eu-west worker",
  });
}
