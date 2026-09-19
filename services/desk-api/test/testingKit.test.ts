/**
 * The desk's run over the real SDK and the SDK's CI kit (`@airprompter/agent-sdk/testing`): a `FakeControlPlane`
 * promotes the four Zudocs-shaped slots with two independent per-prompt experiments (a reply candidate at 50 %, a
 * triage candidate at 50 %), two `AirPrompterAgent`s start against it as two hosts with their own state
 * directories, and `runTicket` — the same function the us-east Lambda and the eu-west worker call — runs every
 * seeded ticket on both with fake model callers. What this pins: the arm is the customer's (the same customer, the
 * same arm on both hosts, with no coordination — the protocol's assignment hash over the manifest's salt), the two
 * experiments split independently, `customer_tier` is filled from the desk's own source (`your_source` on the record),
 * the fence is on the ticket text, the version badge follows the arm, and the SDK's observation (not a stopwatch)
 * lands on the record — all with no network, no key and no model.
 *
 * @example
 * ```sh
 * npx tsx --test test/testingKit.test.ts
 * ```
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AirPrompterAgent, publicJwkOf, releaseDigest, type Experiment } from "@airprompter/agent-sdk";
import { FakeControlPlane } from "@airprompter/agent-sdk/testing";
import { foldArms } from "../src/arms.js";
import { collectObservations, tapObservations } from "../src/observe.js";
import { runTicket, TAGS } from "../src/run.js";
import type { RunHost } from "../src/runtime.js";
import { SEED_CUSTOMERS, SEED_TICKETS } from "../src/seedData.js";
import type { Customer, Store, Ticket } from "../src/store.js";

function memoryStore(): Pick<Store, "getCustomer" | "putRun" | "updateTicketLastRun" | "appendEvent"> & { runs: any[]; events: any[] } {
  const self = {
    runs: [] as any[],
    events: [] as any[],
    getCustomer: async (id: string) => SEED_CUSTOMERS.find((c) => c.customerId === id) ?? null,
    putRun: async (run: any) => void self.runs.push(run),
    updateTicketLastRun: async () => undefined,
    appendEvent: async (e: any) => void self.events.push(e),
  };
  return self;
}

const VARIABLES = {
  triage: [{ name: "ticket", required: true, trust: "end_user" as const }],
  reply: [{ name: "tone", required: false, trust: "operator" as const, default: "friendly" }, { name: "customer_tier", required: true, trust: "operator" as const, source: "runtime" as const }, { name: "ticket", required: true, trust: "end_user" as const }],
};

async function host(plane: FakeControlPlane, hostId: string, store: ReturnType<typeof memoryStore>, calls: string[]): Promise<RunHost & { ap: AirPrompterAgent; stateDir: string }> {
  const stateDir = mkdtempSync(join(tmpdir(), `zudocs-kit-${hostId.replace(/[^a-z0-9]/gi, "-")}-`));
  const ap = await AirPrompterAgent.start({
    ...plane.scope,
    apiKey: plane.apiKey,
    baseUrl: "https://api.test",
    stateDir,
    root: { pinned: publicJwkOf(plane.rootKey), hostedEnvironment: "dev" },
    sync: { mode: "resident", pollSeconds: 3600, rootUrl: "https://edge.test/roots/dev/root.json" },
    fetch: plane.fetch(),
    telemetry: { sink: "memory" },
    models: ["amazon.nova-micro", "amazon.nova-2-lite"],
    variables: { customer_tier: { resolve: async ({ subject }) => (subject ? (await store.getCustomer(subject))?.tier : undefined), trust: "operator" } },
  });
  tapObservations(ap);
  return {
    env: { hostId },
    ap,
    stateDir,
    store: store as unknown as Store,
    observed: collectObservations,
    callers: {
      judgeModel: "amazon.nova-micro",
      complete: async (rendered) => {
        calls.push(`${hostId} ${rendered.model}`);
        // The observation the SDK files is what the record shows: the call goes through ap.observe with the render.
        return ap.observe({ tag: rendered.text.startsWith("Triage") ? TAGS.triage : TAGS.reply, versionId: "x", arm: "x", model: rendered.model }, async () => ({ text: rendered.model === "amazon.nova-micro" ? '{"category":"billing","priority":"normal","summary":"double charge"}' : `Reply. The Zudocs team`, response: { usage: { input_tokens: 50, output_tokens: 12 } } }));
      },
      judge: async () => JSON.stringify({ verdicts: [{ criterion: 1, verdict: "pass" }, { criterion: 2, verdict: "pass" }] }),
      golden: async () => ({ text: "{}", outputTokens: 1 }),
    },
  };
}

test("the /testing kit: two hosts, two independent experiments, sticky arms per customer, the desk's source and fence on the record", async () => {
  const plane = new FakeControlPlane({ organizationId: "org_zudocs", agentId: "agt_zudocs", target: "dev" });
  const triage = plane.slot({ tag: TAGS.triage, text: "Triage A: {{ticket}}", versionId: "rev-2", model: "amazon.nova-micro", variables: VARIABLES.triage });
  const triageB = plane.slot({ tag: TAGS.triage, text: "Triage B: {{ticket}}", versionId: "rev-9", model: "amazon.nova-micro", variables: VARIABLES.triage });
  const reply = plane.slot({ tag: TAGS.reply, text: "Reply A ({{tone}}, {{customer_tier}}): {{ticket}}\n\n## Success criteria\n- Greets the customer\n- Signs off as the Zudocs team", versionId: "rev-3", model: "amazon.nova-2-lite", variables: VARIABLES.reply, inference: { temperatureMilli: 300, maxOutputTokens: 600 } });
  const replyB = plane.slot({ tag: TAGS.reply, text: "Reply B ({{tone}}, {{customer_tier}}): {{ticket}} Warmly\n\n## Success criteria\n- Greets the customer\n- Signs off as the Zudocs team", versionId: "rev-6", model: "amazon.nova-2-lite", variables: VARIABLES.reply, inference: { temperatureMilli: 300, maxOutputTokens: 600 } });
  const summary = plane.slot({ tag: TAGS.summary, text: "Summary: {{ticket}}", versionId: "rev-5", model: "amazon.nova-2-lite", variables: VARIABLES.triage });
  const handoff = plane.slot({ tag: TAGS.handoff, text: "Handoff: {{summary}} {{customer_tier}}", versionId: "rev-3", model: "amazon.nova-2-lite", variables: [{ name: "summary", required: true, trust: "operator" }, { name: "customer_tier", required: true, trust: "operator", source: "runtime" }] });
  const base = releaseDigest([triage, reply, summary, handoff]);
  const experiments: Experiment[] = [
    { experimentId: "exp_reply", tag: TAGS.reply, salt: "EBESExQVFhcYGRobHB0eHw", subjectKey: "request", arms: [{ arm: "control", weightBps: 5000, releaseDigest: base, overrides: [] }, { arm: "candidate", weightBps: 5000, releaseDigest: releaseDigest([triage, replyB, summary, handoff]), overrides: [replyB] }] },
    { experimentId: "exp_triage", tag: TAGS.triage, salt: "AAECAwQFBgcICQoLDA0ODw", subjectKey: "request", arms: [{ arm: "control", weightBps: 5000, releaseDigest: base, overrides: [] }, { arm: "candidate", weightBps: 5000, releaseDigest: releaseDigest([triageB, reply, summary, handoff]), overrides: [triageB] }] },
  ];
  plane.promote([triage, reply, summary, handoff], { applyPolicy: "auto", experiments });

  const store = memoryStore();
  const calls: string[] = [];
  const east = await host(plane, "us-east-1/lambda", store, calls);
  const west = await host(plane, "eu-west-1/ec2", store, calls);
  try {
    assert.equal(east.ap.generation, 1);
    assert.equal(west.ap.generation, 1);
    assert.deepEqual(east.ap.status().variables.sources, ["customer_tier"], "the desk's source is registered");
    assert.equal(east.ap.manifest?.payload.experiments?.length, 2, "two experiments on the manifest");

    // Every seeded ticket on both hosts; subjects are stable customer ids, so the arms must agree host to host.
    for (const ticket of SEED_TICKETS) {
      for (const h of [east, west]) {
        const record = await runTicket(h, ticket as Ticket, { by: "kit", kind: "run", capUsed: 1 });
        assert.equal(record.ok, true, `${h.env.hostId} ${ticket.ticketId}: every step answered`);
        const replyStep = record.steps.find((s) => s.step === "reply")!;
        assert.ok(["control", "candidate"].includes(replyStep.arm!), "the reply is on an arm");
        assert.equal(replyStep.versionId, replyStep.arm === "candidate" ? "rev-6" : "rev-3", "the version badge follows the arm");
        assert.ok(replyStep.rendered!.text.startsWith(replyStep.arm === "candidate" ? "Reply B" : "Reply A"));
        const tier = replyStep.rendered!.variables.find((v) => v.name === "customer_tier")!;
        const customer = SEED_CUSTOMERS.find((c) => c.customerId === ticket.customerId) as Customer;
        assert.deepEqual({ origin: tier.origin, value: tier.value }, { origin: "your_source", value: customer.tier }, "customer_tier came from the desk's own table");
        const tone = replyStep.rendered!.variables.find((v) => v.name === "tone")!;
        assert.equal(tone.origin, customer.tier === "enterprise" ? "call_site" : "default");
        assert.equal(tone.value, customer.tier === "enterprise" ? "formal" : "friendly");
        const fenced = replyStep.rendered!.variables.find((v) => v.name === "ticket")!;
        assert.equal(fenced.fenced, true);
        assert.ok(replyStep.rendered!.text.includes(`<ticket>`), "end-user text rides inside a fence");
        assert.equal(replyStep.observation?.usageSource, "reported");
        assert.equal(replyStep.observation?.tokens?.output, 12, "the SDK's observation, read off the provider's usage");
        assert.equal(replyStep.checks.length, 0, "the kit's slots declare no checks");
        assert.equal(replyStep.judge?.taskPass, 2);
        assert.ok(replyStep.runRef, "a run reference for feedback");
      }
    }
    const { arms, stickiness } = foldArms(store.runs, []);
    const replyArms = arms.filter((a) => a.tag === TAGS.reply);
    const triageArms = arms.filter((a) => a.tag === TAGS.triage);
    assert.ok(replyArms.length === 2, `both reply arms saw traffic: ${JSON.stringify(replyArms.map((a) => [a.arm, a.runs]))}`);
    assert.ok(triageArms.length === 2, `both triage arms saw traffic: ${JSON.stringify(triageArms.map((a) => [a.arm, a.runs]))}`);
    assert.equal(stickiness.length, new Set(SEED_TICKETS.map((t) => t.customerId)).size * 2, "one stickiness row per customer per experiment");
    assert.ok(stickiness.every((s) => s.consistent && Object.keys(s.arms).length === 2), `every customer landed on the same arm on both hosts: ${JSON.stringify(stickiness.filter((s) => !s.consistent))}`);
    // The two splits are independent: the reply arm says nothing about the triage arm.
    const byCustomer = new Map<string, { reply?: string; triage?: string }>();
    for (const s of stickiness) byCustomer.set(s.customerId, { ...byCustomer.get(s.customerId), [s.tag === TAGS.reply ? "reply" : "triage"]: Object.values(s.arms)[0] });
    const combos = new Set([...byCustomer.values()].map((c) => `${c.reply}/${c.triage}`));
    assert.ok(combos.size >= 2, `independent splits produce more than one combination: ${[...combos].join(", ")}`);
    assert.equal(calls.length, SEED_TICKETS.length * 2 * 2, "two model calls per run per host, none elsewhere");
    assert.ok(store.events.every((e) => e.kind === "ticket_run"));
  } finally {
    await east.ap.stop();
    await west.ap.stop();
    rmSync(east.stateDir, { recursive: true, force: true });
    rmSync(west.stateDir, { recursive: true, force: true });
  }
});
