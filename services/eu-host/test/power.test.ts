/**
 * The power function against a fake EC2, SSM and status row: the one live instance by tag (a terminated one left by
 * a replacement is not the host; two live ones are a refusal), sleep stops it and writes `stopping` (refused while
 * the wire is cut, refused to the schedule while demo mode is on and not to the presenter, refused while pending),
 * wake starts it and writes `pending` (refused while stopping), the tick reconciles the marker with EC2 keeping
 * `since` across stopping → stopped and pending → running and dating a change made outside the desk, every change
 * lands on the timeline, a marker is never written on a row that does not exist — and the ticket cadence under
 * the demo-mode switch.
 *
 * @example
 * ```sh
 * npx tsx --test test/power.test.ts
 * ```
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { DescribeInstancesCommand, DescribeSecurityGroupsCommand, StartInstancesCommand, StopInstancesCommand } from "@aws-sdk/client-ec2";
import { GetParameterCommand } from "@aws-sdk/client-ssm";
import { TicketCadence, demoModeDocument } from "../src/demoMode.js";
import { SCHEDULE_BY, liveInstanceOf, power, readEnv, reconciledMarker, type PowerMarker, type PowerPorts } from "../src/power.js";

const NOW = Date.parse("2026-09-21T10:00:00.000Z");
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

const LAUNCHED = new Date(NOW - 86_400_000);

function fake(options: { instances?: Array<{ id: string; state: string; groups?: string[]; launched?: Date }>; wireCut?: boolean; demoMode?: string | null; marker?: PowerMarker | null; rowExists?: boolean; now?: number; raceOnce?: PowerMarker } = {}) {
  const instances = options.instances ?? [{ id: "i-live", state: "running", groups: ["sg-1"] }];
  const calls: string[] = [];
  const events: Record<string, unknown>[] = [];
  let marker: PowerMarker | null = options.marker ?? null;
  let now = options.now ?? NOW;
  let race = options.raceOnce ?? null;
  const ports: PowerPorts = {
    env: { nameTag: "zudocs-eu-host", hostId: "eu-west-1/ec2", dynamoRegion: "us-east-1", statusTable: "s", eventsTable: "e", demoModeParameter: "/zudocs/dev/demo-mode" },
    ec2: {
      async send(command: unknown) {
        if (command instanceof DescribeInstancesCommand) {
          calls.push(`describe:${JSON.stringify(command.input.Filters)}`);
          const states = (command.input.Filters ?? []).find((f) => f.Name === "instance-state-name")?.Values ?? [];
          return { Reservations: [{ Instances: instances.filter((i) => states.includes(i.state)).map((i) => ({ InstanceId: i.id, State: { Name: i.state }, LaunchTime: i.launched ?? LAUNCHED, SecurityGroups: (i.groups ?? []).map((GroupId) => ({ GroupId })) })) }] };
        }
        if (command instanceof DescribeSecurityGroupsCommand) {
          calls.push("describe-groups");
          return { SecurityGroups: [{ GroupId: "sg-1", IpPermissions: [], IpPermissionsEgress: options.wireCut ? [{ IpProtocol: "tcp", FromPort: 443, ToPort: 443, IpRanges: [{ CidrIp: "52.94.0.0/22" }] }] : [{ IpProtocol: "-1", IpRanges: [{ CidrIp: "0.0.0.0/0" }] }], Tags: [] }] };
        }
        if (command instanceof StopInstancesCommand) {
          calls.push(`stop:${command.input.InstanceIds!.join(",")}`);
          for (const i of instances) if (command.input.InstanceIds!.includes(i.id)) i.state = "stopping";
          return {};
        }
        if (command instanceof StartInstancesCommand) {
          calls.push(`start:${command.input.InstanceIds!.join(",")}`);
          for (const i of instances) if (command.input.InstanceIds!.includes(i.id)) i.state = "pending";
          return {};
        }
        throw new Error(`unexpected ${String((command as { constructor: { name: string } }).constructor.name)}`);
      },
    } as PowerPorts["ec2"],
    ssm: {
      async send(command: unknown) {
        if (command instanceof GetParameterCommand) {
          calls.push(`ssm:${command.input.Name}`);
          if (options.demoMode === null) throw Object.assign(new Error("not found"), { name: "ParameterNotFound" });
          return { Parameter: { Value: options.demoMode ?? '{"mode":"off"}' } };
        }
        throw new Error("unexpected ssm command");
      },
    } as PowerPorts["ssm"],
    readMarker: async () => marker,
    writeMarker: async (m, previousAt) => {
      if (options.rowExists === false) return "no_row";
      if (race) {
        // Someone else's write landed between the read and this write (the presenter's own click, another tick).
        marker = race;
        race = null;
        calls.push(`raced:${m.state}`);
        return "raced";
      }
      if ((marker?.at ?? null) !== previousAt) {
        calls.push(`raced:${m.state}`);
        return "raced";
      }
      marker = m;
      calls.push(`marker:${m.state}`);
      return "written";
    },
    appendEvent: async (e) => void events.push(e),
    now: () => now,
  };
  return { ports, calls, events, instances, marker: () => marker, advance: (ms: number) => { now += ms; } };
}

test("the environment: every name required, the parameter a name", () => {
  const env = readEnv({ NAME_TAG: "zudocs-eu-host", HOST_ID: "eu-west-1/ec2", DYNAMODB_REGION: "us-east-1", STATUS_TABLE: "s", EVENTS_TABLE: "e", DEMO_MODE_PARAMETER: "/zudocs/dev/demo-mode" });
  assert.equal(env.demoModeParameter, "/zudocs/dev/demo-mode");
  assert.throws(() => readEnv({ NAME_TAG: "x", HOST_ID: "h", DYNAMODB_REGION: "r", STATUS_TABLE: "s", EVENTS_TABLE: "e" }), /DEMO_MODE_PARAMETER is missing/);
  assert.throws(() => readEnv({ NAME_TAG: "x", HOST_ID: "h", DYNAMODB_REGION: "r", STATUS_TABLE: "s", EVENTS_TABLE: "e", DEMO_MODE_PARAMETER: "on" }), /starts with \//);
});

test("pure helpers: the one live instance by tag (terminated ones ignored, two live ones refused); the reconciled marker keeps `since` along a sleep or a wake and dates an outside change", () => {
  assert.deepEqual(liveInstanceOf([{ Instances: [{ InstanceId: "i-old", State: { Name: "terminated" } }, { InstanceId: "i-new", State: { Name: "running" }, SecurityGroups: [{ GroupId: "sg-1" }] }] }]).instance?.instanceId, "i-new");
  assert.equal(liveInstanceOf([{ Instances: [{ InstanceId: "i-old", State: { Name: "terminated" } }] }]).refusal, "no_instance");
  assert.equal(liveInstanceOf([]).refusal, "no_instance");
  assert.equal(liveInstanceOf([{ Instances: [{ InstanceId: "a", State: { Name: "running" } }, { InstanceId: "b", State: { Name: "pending" } }] }]).refusal, "several_instances", "a replacement in progress: nothing is stopped or started");
  const stopping: PowerMarker = { state: "stopping", since: iso(-60_000), at: iso(-60_000), by: "seth@zudocs.com", instanceId: "i-live" };
  assert.equal(reconciledMarker(stopping, "stopping", "i-live", NOW, "the tick"), null, "nothing to write when EC2 agrees");
  const stopped = reconciledMarker(stopping, "stopped", "i-live", NOW, "observed by the tick")!;
  assert.equal(stopped.since, iso(-60_000), "asleep since the sleep began");
  assert.equal(stopped.by, "seth@zudocs.com", "still the presenter's sleep");
  assert.equal(stopped.at, iso(0));
  const pending: PowerMarker = { state: "pending", since: iso(-30_000), at: iso(-30_000), by: "seth@zudocs.com", instanceId: "i-live" };
  assert.equal(reconciledMarker(pending, "running", "i-live", NOW, "x")!.since, iso(-30_000));
  const outside = reconciledMarker({ ...stopped }, "running", "i-live", NOW + 1000, "the tick", iso(-5 * 60_000))!;
  assert.equal(outside.since, iso(-5 * 60_000), "started outside the desk: dated from EC2's launch time (it moves on every start), so the workers' rows are newer than it");
  assert.equal(outside.by, "the tick");
  assert.equal(reconciledMarker({ ...stopped }, "running", "i-live", NOW + 1000, "the tick", null)!.since, iso(1000), "no launch time known: dated when found");
  assert.equal(reconciledMarker({ ...stopped }, "running", "i-live", NOW, "the tick", iso(60_000))!.since, iso(0), "a launch time in the future (clock skew) is not trusted");
  assert.equal(reconciledMarker(stopped, "stopped", "i-other", NOW, "the tick")!.since, iso(0), "another instance id is another host: dated now");
  assert.equal(reconciledMarker(null, "stopped", "i-live", NOW, "the tick")!.since, iso(0));
  assert.equal(reconciledMarker(null, "running", "i-live", NOW, "the tick", iso(-3_600_000))!.since, iso(-3_600_000), "a first look at a running host: since its launch");
});

test("sleep: stops the tagged instance and writes stopping; a second sleep changes nothing; refused while pending, while the wire is cut, and to the schedule while demo mode is on (not to the presenter)", async () => {
  const f = fake();
  const slept = await power({ action: "sleep", by: "seth@zudocs.com" }, f.ports);
  assert.equal(slept.state, "stopping");
  assert.equal(slept.changed, true);
  assert.equal(slept.refusal, null);
  assert.ok(f.calls.includes("stop:i-live"), "StopInstances on the tagged instance");
  assert.ok(f.calls.some((c) => c.startsWith("describe:") && c.includes('"tag:Name"') && c.includes("zudocs-eu-host") && c.includes('"instance-state-name"')), "described by tag and live states only");
  assert.deepEqual(f.marker()!.state, "stopping");
  assert.equal(f.marker()!.by, "seth@zudocs.com");
  assert.equal(f.events.at(-1)!.kind, "power");
  assert.equal(f.events.at(-1)!.state, "stopping");
  const again = await power({ action: "sleep", by: "seth@zudocs.com" }, f.ports);
  assert.equal(again.changed, false);
  assert.equal(f.calls.filter((c) => c.startsWith("stop:")).length, 1, "stopping already: not stopped twice");

  const pending = fake({ instances: [{ id: "i-live", state: "pending", groups: ["sg-1"] }] });
  const p = await power({ action: "sleep", by: "seth@zudocs.com" }, pending.ports);
  assert.equal(p.refusal, "instance_pending");
  assert.equal(pending.calls.filter((c) => c.startsWith("stop:")).length, 0, "nothing stopped");
  assert.equal(pending.events.at(-1)!.refusal, "instance_pending", "the refusal of an act is on the timeline");

  const cut = fake({ wireCut: true });
  const c = await power({ action: "sleep", by: "seth@zudocs.com" }, cut.ports);
  assert.equal(c.refusal, "wire_cut");
  assert.match(c.message, /restore it first/);
  assert.equal(cut.calls.filter((x) => x.startsWith("stop:")).length, 0);

  const demo = fake({ demoMode: demoModeDocument("on", "seth@zudocs.com", NOW) });
  const d = await power({ action: "sleep", by: SCHEDULE_BY }, demo.ports);
  assert.equal(d.refusal, "demo_mode_on", "the schedule never stops a host mid-session");
  assert.match(d.message, /seth@zudocs.com/);
  assert.equal(demo.calls.filter((x) => x.startsWith("stop:")).length, 0, "nothing stopped while demo mode is on");
  assert.ok(demo.calls.includes("ssm:/zudocs/dev/demo-mode"), "the switch was read by name");
  const presenter = await power({ action: "sleep", by: "seth@zudocs.com" }, demo.ports);
  assert.equal(presenter.refusal, null, "the presenter's own click is honoured whatever the switch says");
  assert.equal(demo.calls.filter((x) => x.startsWith("stop:")).length, 1);

  const expired = fake({ demoMode: demoModeDocument("on", "seth@zudocs.com", NOW - 5 * 3_600_000) });
  assert.equal((await power({ action: "sleep", by: SCHEDULE_BY }, expired.ports)).refusal, null, "a lapsed switch does not hold the host up");
  const missing = fake({ demoMode: null });
  assert.equal((await power({ action: "sleep", by: SCHEDULE_BY }, missing.ports)).refusal, null, "no parameter at all is off");
});

test("wake: starts a stopped instance and writes pending; already running or pending changes nothing; refused while stopping", async () => {
  const f = fake({ instances: [{ id: "i-live", state: "stopped", groups: ["sg-1"] }], marker: { state: "stopped", since: iso(-8 * 3_600_000), at: iso(-8 * 3_600_000), by: SCHEDULE_BY, instanceId: "i-live" } });
  const woken = await power({ action: "wake", by: "seth@zudocs.com" }, f.ports);
  assert.equal(woken.state, "pending");
  assert.equal(woken.changed, true);
  assert.ok(f.calls.includes("start:i-live"), "StartInstances on the tagged instance");
  assert.equal(f.marker()!.state, "pending");
  assert.equal(f.marker()!.since, iso(0), "a wake is a new run of the state");
  assert.match(woken.message, /re-reads its key/);
  const again = await power({ action: "wake", by: "seth@zudocs.com" }, f.ports);
  assert.equal(again.changed, false);
  assert.equal(f.calls.filter((c) => c.startsWith("start:")).length, 1);
  const stopping = fake({ instances: [{ id: "i-live", state: "stopping" }] });
  assert.equal((await power({ action: "wake", by: "x" }, stopping.ports)).refusal, "instance_stopping");
  const running = fake();
  const r = await power({ action: "wake", by: "x" }, running.ports);
  assert.equal(r.changed, false);
  assert.match(r.message, /already awake/);
});

test("the tick reconciles: stopping → stopped keeps since (asleep since the sleep began), a start outside the desk is dated when found, an agreeing marker writes nothing, no live instance is said", async () => {
  const f = fake({ instances: [{ id: "i-live", state: "stopped" }], marker: { state: "stopping", since: iso(-90_000), at: iso(-90_000), by: "seth@zudocs.com", instanceId: "i-live" } });
  const t = await power({ action: "tick" }, f.ports);
  assert.equal(t.state, "stopped");
  assert.equal(t.changed, true);
  assert.equal(f.marker()!.state, "stopped");
  assert.equal(f.marker()!.since, iso(-90_000));
  assert.equal(f.marker()!.by, "seth@zudocs.com");
  assert.match(t.message, /asleep since 2026-09-21T09:58:30.000Z/);
  assert.equal(f.events.at(-1)!.observed, true);
  const quiet = await power({ action: "tick" }, f.ports);
  assert.equal(quiet.changed, false);
  assert.equal(f.events.length, 1, "an agreeing tick writes no row");
  f.instances[0]!.state = "running";
  f.instances[0]!.launched = new Date(NOW + 30_000);
  f.advance(60_000);
  const outside = await power({ action: "status" }, f.ports);
  assert.equal(outside.state, "running");
  assert.equal(f.marker()!.since, iso(30_000), "started outside the desk: dated from EC2's launch time");
  assert.equal(f.marker()!.by, "the desk");
  assert.equal(f.events.at(-1)!.observed, true, "an observed change is a row");

  const gone = fake({ instances: [{ id: "i-old", state: "terminated" }] });
  const g = await power({ action: "tick" }, gone.ports);
  assert.equal(g.refusal, "no_instance");
  assert.equal(g.state, null);
  assert.equal(gone.events.length, 0, "a tick with nothing to reconcile writes no row (a replacement in flight would otherwise fill the timeline)");
  const two = fake({ instances: [{ id: "a", state: "running" }, { id: "b", state: "pending" }] });
  assert.equal((await power({ action: "sleep", by: "x" }, two.ports)).refusal, "several_instances");
  assert.equal(two.calls.filter((c) => c.startsWith("stop:")).length, 0, "nothing stopped during a replacement");
  assert.equal(two.events.length, 1, "a refused act is a row");
  assert.equal((await power({ action: "status" }, two.ports)).refusal, "several_instances");
  assert.equal(two.events.length, 1, "a refused look is not");

  const noRow = fake({ instances: [{ id: "i-live", state: "stopped" }], rowExists: false });
  const n = await power({ action: "tick" }, noRow.ports);
  assert.equal(n.state, "stopped");
  assert.equal(noRow.marker(), null, "no row, no marker: a bare row the card cannot render is never created");
  assert.equal(noRow.events.length, 1, "the timeline still says what was found");

  // The race: the tick read `running` (no marker), then the presenter's sleep wrote `stopping` before the tick's write landed.
  const presenters: PowerMarker = { state: "stopping", since: iso(-1000), at: iso(-1000), by: "seth@zudocs.com", instanceId: "i-live" };
  const raced = fake({ instances: [{ id: "i-live", state: "stopping" }], marker: null, raceOnce: presenters });
  const r = await power({ action: "tick" }, raced.ports);
  assert.ok(raced.calls.includes("raced:stopping"), "the conditional write refused");
  assert.equal(raced.events.length, 0, "no row layered over the presenter's");
  assert.deepEqual(r.marker, presenters, "the answer carries the marker that won");
  assert.equal(raced.marker()!.by, "seth@zudocs.com", "the presenter's sleep stands");
});

test("the ticket cadence under the switch: due once per interval; switching on pulls the next ticket to within the demo interval; switching off never pushes a due ticket out", () => {
  const cadence = new TicketCadence({ idle: 3600, demo: 120 }, "off", NOW, 90_000);
  assert.equal(cadence.intervalSeconds, 3600);
  assert.equal(cadence.due(NOW + 60_000), false);
  assert.equal(cadence.due(NOW + 90_000), true, "the first ticket at the first delay");
  assert.equal(cadence.due(NOW + 100_000), false, "once per interval");
  assert.equal(cadence.nextAt, iso(90_000 + 3_600_000));
  assert.equal(cadence.setMode("on", NOW + 200_000), true);
  assert.equal(cadence.intervalSeconds, 120);
  assert.equal(cadence.nextAt, iso(200_000 + 120_000), "switched on: the next ticket is one demo interval away, not an hour");
  assert.equal(cadence.setMode("on", NOW + 200_000), false, "the same mode again changes nothing");
  assert.equal(cadence.due(NOW + 320_000), true);
  assert.equal(cadence.nextAt, iso(320_000 + 120_000));
  assert.equal(cadence.setMode("off", NOW + 330_000), true);
  assert.equal(cadence.nextAt, iso(440_000), "switched off: the ticket already due in 110 s still runs; the one after is an hour later");
  assert.equal(cadence.due(NOW + 440_000), true);
  assert.equal(cadence.nextAt, iso(440_000 + 3_600_000));
});
