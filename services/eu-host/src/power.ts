/**
 * The power: the eu-west host stopped and started at EC2 — "Sleep" and "Wake the fleet" on the desk, and the
 * nightly schedule. A stopped `t4g.micro` bills nothing but its 8 GiB volume (no Elastic IP is allocated; the
 * auto-assigned public IPv4 is released and a new one arrives on start — nothing depends on it: the host has no
 * inbound rule, Run Command targets it by tag, and its own calls are outbound).
 *
 * - `sleep`: `StopInstances` on the one instance carrying the `zudocs-eu-host` Name tag — refused while the wire is
 *   cut (a host that sleeps behind a cut wire wakes into one; restore first — the rule does within fifteen minutes),
 *   refused to the *schedule* while demo mode is on (`demoMode.ts`: a session in progress is never stopped by a
 *   clock; the presenter's own click is honoured), and refused while a replacement is in progress (two instances
 *   carry the tag). The status row's `power` marker says `stopping` at once, so the card reads *going to sleep*
 *   before the workers' rows go quiet; the tick moves it to `stopped` — *asleep since …* — when EC2 says so.
 * - `wake`: `StartInstances` when stopped; the marker says `pending`, then `running` on the tick; the daemon's unit
 *   re-reads the Agent key from SSM before it starts, the workers re-attach, and their rows follow within minutes.
 * - `tick` (every five minutes) and `status`: reconcile the marker with what EC2 says — a host someone stopped or
 *   started outside the desk is shown as it is (a running one dated from EC2's launch time, a stopped one from the
 *   instant the tick found it). A `stopping → stopped` or `pending → running` step keeps the marker's `since`, so
 *   *asleep since* is when the sleep began. A tick that finds nothing to reconcile with (no live instance, two of
 *   them during a replacement) answers so and writes no row.
 *
 * The marker is written with a condition that the host's row exists (this function never creates a bare row the
 * card cannot render) and that the marker is still the one this invocation read (a tick that lost the race to the
 * presenter's own click drops its write). Every change is a `power` row on the desk's timeline. IAM: start and stop only on instances
 * carrying the Name tag; describe is read-only; one SSM parameter (the demo-mode switch) by name.
 *
 * @example
 * ```ts
 * export const handler = async (event: { action: "sleep" | "wake" | "status" | "tick"; by?: string }) => ...;
 * // aws lambda invoke --function-name zudocs-power --payload '{"action":"wake","by":"the owner"}' /dev/stdout
 * ```
 */
import { DescribeInstancesCommand, DescribeSecurityGroupsCommand, EC2Client, StartInstancesCommand, StopInstancesCommand } from "@aws-sdk/client-ec2";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { SSMClient } from "@aws-sdk/client-ssm";
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { parseDemoMode, readDemoModeParameter, type DemoModeDoc } from "./demoMode.js";
import { stateOf } from "./wire.js";

export type PowerState = "pending" | "running" | "stopping" | "stopped";
export type PowerAction = "sleep" | "wake" | "status" | "tick";
/** The instance states this function acts on — a terminated instance left by a replacement still carries the tag and is not the host. */
export const LIVE_STATES: readonly PowerState[] = Object.freeze(["pending", "running", "stopping", "stopped"]);

export interface PowerEvent {
  action?: PowerAction;
  by?: string;
}

/** The `power` attribute on the host's status row: what the desk's card reads. */
export interface PowerMarker {
  state: PowerState;
  /** When this run of the state began (a sleep's `stopping` and its `stopped` share it: "asleep since"). */
  since: string;
  /** When the marker was last written. */
  at: string;
  by: string;
  instanceId: string | null;
}

export interface PowerAnswer {
  action: PowerAction;
  hostId: string;
  instanceId: string | null;
  state: PowerState | null;
  changed: boolean;
  /** Why nothing was done: wire_cut, demo_mode_on, no_instance, several_instances, instance_pending, instance_stopping — null when the action went through or was already the case. */
  refusal: string | null;
  marker: PowerMarker | null;
  message: string;
}

export interface Env {
  nameTag: string;
  hostId: string;
  dynamoRegion: string;
  statusTable: string;
  eventsTable: string;
  demoModeParameter: string;
}

export const readEnv = (env: NodeJS.ProcessEnv): Env => {
  const need = (name: string): string => {
    const value = env[name]?.trim();
    if (!value) throw new Error(`power: ${name} is missing`);
    return value;
  };
  const parameter = need("DEMO_MODE_PARAMETER");
  if (!parameter.startsWith("/")) throw new Error("power: DEMO_MODE_PARAMETER is an SSM parameter name (it starts with /)");
  return { nameTag: need("NAME_TAG"), hostId: need("HOST_ID"), dynamoRegion: need("DYNAMODB_REGION"), statusTable: need("STATUS_TABLE"), eventsTable: need("EVENTS_TABLE"), demoModeParameter: parameter };
};

export interface Instance {
  instanceId: string;
  state: PowerState;
  launchTime: string | null;
  securityGroupIds: string[];
}

export interface PowerPorts {
  env: Env;
  ec2: Pick<EC2Client, "send">;
  ssm: Pick<SSMClient, "send">;
  readMarker: () => Promise<PowerMarker | null>;
  /**
   * SET the marker on the host's row, only if the row exists (nothing is created) and its marker is still the one
   * that was read (`previousAt`; a write that lost the race to the presenter's own is dropped, not layered over it).
   */
  writeMarker: (marker: PowerMarker, previousAt: string | null) => Promise<"written" | "no_row" | "raced">;
  appendEvent: (event: Record<string, unknown>) => Promise<void>;
  now: () => number;
}

/** The one live instance carrying the tag, from a DescribeInstances answer: null for none, a refusal for several. Pure. */
export function liveInstanceOf(reservations: Array<{ Instances?: Array<{ InstanceId?: string; State?: { Name?: string }; LaunchTime?: Date; SecurityGroups?: Array<{ GroupId?: string }> }> }>): { instance: Instance | null; refusal: string | null; count: number } {
  const live = reservations.flatMap((r) => r.Instances ?? []).filter((i) => i.InstanceId && LIVE_STATES.includes((i.State?.Name ?? "") as PowerState));
  if (live.length === 0) return { instance: null, refusal: "no_instance", count: 0 };
  if (live.length > 1) return { instance: null, refusal: "several_instances", count: live.length };
  const i = live[0]!;
  return { instance: { instanceId: i.InstanceId!, state: i.State!.Name as PowerState, launchTime: i.LaunchTime ? new Date(i.LaunchTime).toISOString() : null, securityGroupIds: (i.SecurityGroups ?? []).map((g) => g.GroupId).filter((g): g is string => Boolean(g)) }, refusal: null, count: 1 };
}

/**
 * The marker the tick writes when EC2's state differs from the row's: the same sleep or wake keeps its `since`
 * (stopping → stopped, pending → running); a host found running without a wake of ours is dated from EC2's launch
 * time (which moves on every start from stopped — so the workers' last row is newer than it and the card reads
 * awake at once, not "coming up" for a status interval); anything else is a new run of the state, dated now. Pure.
 */
export function reconciledMarker(previous: PowerMarker | null, state: PowerState, instanceId: string, nowMs: number, by: string, launchTime: string | null = null): PowerMarker | null {
  if (previous && previous.state === state && previous.instanceId === instanceId) return null;
  const at = new Date(nowMs).toISOString();
  const continues = previous && previous.instanceId === instanceId && ((previous.state === "stopping" && state === "stopped") || (previous.state === "pending" && state === "running"));
  const since = continues ? previous!.since : state === "running" && launchTime && Date.parse(launchTime) <= nowMs ? launchTime : at;
  return { state, since, at, by: continues ? previous!.by : by, instanceId };
}

/**
 * The UpdateItem input that writes the marker: the row must exist, and its marker must be the one that was read
 * (none when `previousAt` is null). Every placeholder in the names and values maps is referenced by the expressions
 * (DynamoDB refuses an unused one) — the test pins that for both branches. Pure.
 */
export function markerUpdateInput(table: string, hostId: string, marker: PowerMarker, previousAt: string | null): { TableName: string; Key: { hostId: string }; UpdateExpression: string; ConditionExpression: string; ExpressionAttributeNames: Record<string, string>; ExpressionAttributeValues: Record<string, unknown>; ReturnValuesOnConditionCheckFailure: "ALL_OLD" } {
  return {
    TableName: table,
    Key: { hostId },
    UpdateExpression: "SET #p = :m",
    ConditionExpression: previousAt === null ? "attribute_exists(hostId) AND attribute_not_exists(#p)" : "attribute_exists(hostId) AND #p.#at = :prev",
    ExpressionAttributeNames: { "#p": "power", ...(previousAt === null ? {} : { "#at": "at" }) },
    ExpressionAttributeValues: { ":m": marker, ...(previousAt === null ? {} : { ":prev": previousAt }) },
    ReturnValuesOnConditionCheckFailure: "ALL_OLD",
  };
}

const describeInstance = async (ports: PowerPorts): Promise<{ instance: Instance | null; refusal: string | null; count: number }> => {
  const out = await ports.ec2.send(new DescribeInstancesCommand({ Filters: [{ Name: "tag:Name", Values: [ports.env.nameTag] }, { Name: "instance-state-name", Values: [...LIVE_STATES] }] }));
  return liveInstanceOf(out.Reservations ?? []);
};

const wireIsCut = async (ports: PowerPorts, instance: Instance): Promise<boolean> => {
  if (instance.securityGroupIds.length === 0) return false;
  const out = await ports.ec2.send(new DescribeSecurityGroupsCommand({ GroupIds: instance.securityGroupIds }));
  return (out.SecurityGroups ?? []).some((g) => stateOf(g).state === "cut");
};

const demoModeOf = async (ports: PowerPorts): Promise<DemoModeDoc> => {
  try {
    return parseDemoMode(await readDemoModeParameter(ports.ssm, ports.env.demoModeParameter), ports.now());
  } catch {
    // Unreadable is off: the schedule then stops the host, which is the safe side of a cost knob.
    return { mode: "off", until: null, by: null, reason: "unreadable" };
  }
};

export async function power(event: PowerEvent, ports: PowerPorts): Promise<PowerAnswer> {
  const { env, now } = ports;
  const action = event.action ?? "status";
  const by = (event.by ?? "the tick").slice(0, 120);
  const at = () => new Date(now()).toISOString();
  const found = await describeInstance(ports);
  const previous = await ports.readMarker();
  const answer = (state: PowerState | null, instanceId: string | null, changed: boolean, refusal: string | null, marker: PowerMarker | null, message: string): PowerAnswer => ({ action, hostId: env.hostId, instanceId, state, changed, refusal, marker, message });
  let known = previous;
  let changed = false;
  const record = async (marker: PowerMarker, extra: Record<string, unknown> = {}): Promise<boolean> => {
    const outcome = await ports.writeMarker(marker, known?.at ?? null);
    if (outcome === "raced") {
      // Someone (the presenter's own sleep or wake, another tick) wrote a newer marker between the read and this write: theirs stands.
      console.log(JSON.stringify({ source: "zudocs-power", event: "marker_raced", state: marker.state }));
      return false;
    }
    if (outcome === "no_row") {
      // No status row yet (the workers never wrote one): nothing to mark and no row on the timeline — a tick every five
      // minutes would otherwise fill it; the log says so and the answer carries the state.
      console.log(JSON.stringify({ source: "zudocs-power", event: "marker_not_written", reason: "the host's status row does not exist yet", state: marker.state }));
      return false;
    }
    known = marker;
    changed = true;
    await ports.appendEvent({ at: marker.at, kind: "power", host: env.hostId, forHost: env.hostId, action, state: marker.state, by: marker.by, instanceId: marker.instanceId, ...extra }).catch(() => undefined);
    return true;
  };
  /**
   * The act's own marker, after Stop/StartInstances was issued. A desk poll that saw EC2 move may have written the
   * same transition first (`observed`, by the desk): then this write loses the race, the stored marker is re-read
   * and, when it is the same transition, written once more with the presenter's name and instant on it — the act
   * happened, and the card and the timeline say who did it.
   */
  const settle = async (next: PowerMarker): Promise<PowerMarker> => {
    if (await record(next)) return next;
    const stored = await ports.readMarker();
    if (stored && stored.state === next.state && stored.instanceId === next.instanceId) {
      known = stored;
      const signed: PowerMarker = { ...next, at: at() };
      if (await record(signed)) return signed;
    }
    return (await ports.readMarker()) ?? next;
  };
  // A refusal to an act (sleep, wake) is a timeline row; a tick or a status that finds nothing to reconcile with
  // (no live instance, two of them) says so in its answer only — a replacement in flight would otherwise write a row
  // every five minutes, and every desk poll one more.
  const refuse = async (refusal: string, message: string, state: PowerState | null, instanceId: string | null): Promise<PowerAnswer> => {
    if (action === "sleep" || action === "wake") await ports.appendEvent({ at: at(), kind: "power", host: env.hostId, forHost: env.hostId, action, state, by, instanceId, refusal }).catch(() => undefined);
    return answer(state, instanceId, false, refusal, previous, message);
  };

  if (!found.instance) {
    if (found.refusal === "several_instances") return refuse("several_instances", `${found.count} instances carry the ${env.nameTag} tag: a replacement is in progress; try again when one is left`, null, null);
    return refuse("no_instance", `no live instance carries the ${env.nameTag} tag (the eu-west stack is not deployed, or the host is being replaced)`, null, null);
  }
  const instance = found.instance;

  // Reconcile first: whatever the action, the marker says what EC2 says.
  let marker = previous;
  const reconciled = reconciledMarker(previous, instance.state, instance.instanceId, now(), action === "tick" ? "the tick" : "the desk", instance.launchTime);
  if (reconciled) {
    if (await record(reconciled, { observed: true })) marker = reconciled;
    else {
      marker = (await ports.readMarker()) ?? previous;
      known = marker;
    }
  }

  switch (action) {
    case "status":
    case "tick":
      return answer(instance.state, instance.instanceId, changed, null, marker, `${env.hostId} is ${instance.state}${marker && marker.state === "stopped" ? ` (asleep since ${marker.since})` : ""}`);
    case "sleep": {
      if (instance.state === "stopped" || instance.state === "stopping") return answer(instance.state, instance.instanceId, false, null, marker, `${env.hostId} is already ${instance.state}`);
      if (instance.state === "pending") return refuse("instance_pending", `${env.hostId} is starting; wait for it to run before putting it to sleep`, instance.state, instance.instanceId);
      if (await wireIsCut(ports, instance)) return refuse("wire_cut", `the wire is cut on ${env.hostId}: restore it first (the rule does within 15 minutes) — a host that sleeps behind a cut wire wakes into one`, instance.state, instance.instanceId);
      if (event.by === SCHEDULE_BY) {
        const demo = await demoModeOf(ports);
        if (demo.mode === "on") return refuse("demo_mode_on", `demo mode is on until ${demo.until ?? "?"} (${demo.by ?? "unknown"}): the schedule does not stop a host mid-session`, instance.state, instance.instanceId);
      }
      await ports.ec2.send(new StopInstancesCommand({ InstanceIds: [instance.instanceId] }));
      const next = await settle({ state: "stopping", since: at(), at: at(), by, instanceId: instance.instanceId });
      return answer("stopping", instance.instanceId, true, null, next, `${env.hostId} is going to sleep (${instance.instanceId}); the card reads asleep when EC2 reports it stopped — only its volume bills until it is woken`);
    }
    case "wake": {
      if (instance.state === "running" || instance.state === "pending") return answer(instance.state, instance.instanceId, false, null, marker, `${env.hostId} is already ${instance.state === "running" ? "awake" : "starting"}`);
      if (instance.state === "stopping") return refuse("instance_stopping", `${env.hostId} is still stopping; wake it once it is stopped (a minute)`, instance.state, instance.instanceId);
      await ports.ec2.send(new StartInstancesCommand({ InstanceIds: [instance.instanceId] }));
      const next = await settle({ state: "pending", since: at(), at: at(), by, instanceId: instance.instanceId });
      return answer("pending", instance.instanceId, true, null, next, `${env.hostId} is waking (${instance.instanceId}): the daemon re-reads its key and the workers re-attach; their rows follow within about three minutes`);
    }
    default:
      throw new Error(`power: unknown action ${String(action)}`);
  }
}

/** What the nightly schedule signs its sleep with; the demo-mode refusal applies to this caller only. */
export const SCHEDULE_BY = "the nightly schedule";

/** The Lambda entry: real clients, the desk's tables across regions. */
export const handler = async (event: PowerEvent): Promise<PowerAnswer> => {
  const env = readEnv(process.env);
  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: env.dynamoRegion }), { marshallOptions: { removeUndefinedValues: true } });
  const ports: PowerPorts = {
    env,
    ec2: new EC2Client({}),
    ssm: new SSMClient({}),
    readMarker: async () => {
      const out = await ddb.send(new GetCommand({ TableName: env.statusTable, Key: { hostId: env.hostId }, ProjectionExpression: "#p", ExpressionAttributeNames: { "#p": "power" } }));
      return (out.Item?.power as PowerMarker | undefined) ?? null;
    },
    writeMarker: async (marker, previousAt) => {
      // The row must exist, and its marker must still be the one this invocation read (or none): a lost race is dropped.
      try {
        await ddb.send(new UpdateCommand(markerUpdateInput(env.statusTable, env.hostId, marker, previousAt)));
        return "written";
      } catch (error) {
        if ((error as Error).name !== "ConditionalCheckFailedException") throw error;
        // The refused write carries the row as it stands (ALL_OLD): a row means the marker moved under us; none means there is no row.
        return (error as { Item?: unknown }).Item ? "raced" : "no_row";
      }
    },
    appendEvent: async (e) => {
      const at = String(e.at);
      const sk = `${at}#${Math.random().toString(36).slice(2, 8)}`;
      const expiresAt = Math.floor(Date.parse(at) / 1000) + 14 * 86_400;
      await ddb.send(new PutCommand({ TableName: env.eventsTable, Item: { day: at.slice(0, 10), sk, expiresAt, ...e } }));
    },
    now: Date.now,
  };
  const answer = await power(event, ports);
  console.log(JSON.stringify({ source: "zudocs-power", ...answer }));
  return answer;
};
