/**
 * Walks a person through the whole outside-customer path and writes down where they got stuck.
 *
 * Every AirPrompter act is the person's, in the console: this script never signs in and never calls a console route.
 * It prints an "In AirPrompter: ..." line and waits. Where the effect shows on the app's own side (a new generation, a
 * ramp), it waits for that. Anything typed at a prompt goes into state/langchain/walk-notes.md with the step it
 * belongs to.
 *
 *   $ npm run walk -- setup                                            # before there is a key
 *   $ npm run walk -- setup existing                                   # an agent that already exists
 *   $ set -a; . ~/.config/zudocs/langchain.env; set +a
 *   $ npm run walk -- run                                              # with the key, to the end
 *
 * It prints counts and ids only, never prompt text, a reply or a key.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { createInterface } from "node:readline";

import { ask, buildAgent, startRuntime } from "./agent.js";
import { readConfig } from "./config.js";

const NOTES = "../../state/langchain/walk-notes.md";
mkdirSync("../../state/langchain", { recursive: true });

const lines = createInterface({ input: process.stdin });
let waiting: ((text: string) => void) | undefined;
let step = "start";
const note = (text: string) => appendFileSync(NOTES, `- ${new Date().toISOString()} [${step}] ${text}\n`);
lines.on("line", (text) => {
  if (waiting) waiting(text);
  else if (text.trim()) note(text.trim());
});

/** One person's act. Enter means done. Any text is kept as a note and the step stays open. */
async function act(name: string, instruction: string): Promise<void> {
  step = name;
  note("shown");
  console.log(`\nIn AirPrompter: ${instruction}`);
  for (;;) {
    process.stdout.write("Press Enter when it is done, or type what stopped you: ");
    const text = await new Promise<string>((resolve) => (waiting = resolve));
    waiting = undefined;
    if (!text.trim()) break;
    note(text.trim());
  }
  note("done");
}

/** One person's act whose effect shows here. Notes are still taken while it waits. */
async function actUntil(name: string, instruction: string, done: () => Promise<boolean>): Promise<void> {
  step = name;
  note("shown");
  console.log(`\nIn AirPrompter: ${instruction}`);
  console.log("Watching for it here. Type a note at any time if something stops you.");
  while (!(await done())) await new Promise((resolve) => setTimeout(resolve, 5_000));
  note("seen");
}

async function setup(existingAgent: boolean): Promise<void> {
  if (!existingAgent) {
    await act("sign-up", "open https://dev.airprompter.com and sign up as a new business with a fresh email. Choose the plan that includes Agents.");
    await act("workspace", "create a workspace of type Agents, named Zudocs Support.");
  }
  await act("prompt-v1", "create a prompt named Zudocs support agent from prompts/langchain/support-agent.v1.md and approve it.");
  if (!existingAgent) {
    await act("agent", "create an agent named Zudocs Support Agent, on your own systems, in that workspace.");
    await act("key", "in the agent's Settings → Keys, mint a key for the Development environment. Copy the organization id, the agent id and the root public key shown there.");
    await act("env", "put them in ~/.config/zudocs/langchain.env (mode 600). Save the root key as a JSON file and point AIRPROMPTER_ROOT_JWK_FILE at it.");
  }
  await act("provider-key", "(not a console step) add OPENAI_API_KEY to ~/.config/zudocs/langchain.env.");
  console.log("\nNext: set -a; . ~/.config/zudocs/dev.env; . ~/.config/zudocs/langchain.env; set +a; npm run walk -- run");
}

async function run(): Promise<void> {
  const config = readConfig(process.env);
  if (!process.env.OPENAI_API_KEY) throw new Error("Missing from the environment: OPENAI_API_KEY");
  const ap = await startRuntime(config, console.log);
  await ap.syncNow();
  let agent = buildAgent(ap, config);
  const report = (label: string) => {
    const health = ap.healthz();
    console.log(`${label}: generation ${ap.generation}, health ${health.status} ${JSON.stringify(health.reasons)}, apply ${ap.status().applyState}, refusal ${ap.status().lastRefusal ?? "none"}`);
  };
  const say = (label: string, outcome: Awaited<ReturnType<typeof ask>>) => console.log(`${label}: ${JSON.stringify(outcome)}`);

  report("started");
  step = "own-prompt";
  say("nothing promoted yet", await ask(agent, "Can we export to PDF on our plan?", "northwind", "before-promotion"));

  const startGeneration = ap.generation;
  await actUntil(
    "promote-v1",
    `on the agent's Board, use Add prompt to add Zudocs support agent. Pin it to ${config.models[0]}, leave the other four prompts as they are, and promote to Development.`,
    async () => ap.generation > startGeneration,
  );
  report("promoted");

  step = "slot-key";
  note("shown");
  process.stdout.write("\nIn AirPrompter: on the Board, hover the new prompt's name. Type its key in code here, then Enter: ");
  const typed = await new Promise<string>((resolve) => (waiting = resolve));
  waiting = undefined;
  config.slot = typed.trim() || config.slot;
  note(`key in code ${config.slot}`);
  agent = buildAgent(ap, config);

  step = "run-v1";
  say("one request on the approved version", await ask(agent, "Can we export to PDF on our plan, and how many seats do we have left?", "northwind", "first-approved"));

  const v1Generation = ap.generation;
  await actUntil(
    "ramp-v2",
    "add a second version of the prompt from prompts/langchain/support-agent.v2.md, approve it, and start a ramp to it on Development at 50%. Leave the other four prompts as they are.",
    async () => ap.generation > v1Generation && ap.status().ramps.length > 0,
  );
  report("ramping");

  step = "traffic";
  const questions = [
    ["Can we export to PDF on our plan, and how many editor seats do we have left?", "northwind"],
    ["How long is our version history kept, and do we have custom domains?", "acme-docs"],
    ["What plan are we on and how many editors does it allow?", "fabrikam"],
  ] as const;
  const totals = { requests: 0, modelCalls: 0, tokensIn: 0, tokensOut: 0, signed: 0 };
  for (let index = 0; index < 20; index += 1) {
    const [question, customer] = questions[index % questions.length]!;
    const outcome = await ask(agent, question, customer, `${customer}-${index}`);
    say(`${customer}-${index}`, outcome);
    totals.requests += 1;
    totals.modelCalls += outcome.modelCalls;
    totals.tokensIn += outcome.tokensIn;
    totals.tokensOut += outcome.tokensOut;
    totals.signed += outcome.signed ? 1 : 0;
  }
  console.log(`totals: ${JSON.stringify(totals)}`);
  note(`totals ${JSON.stringify(totals)}`);
  console.log(`upload: ${JSON.stringify(await ap.uploadNow())}`);

  await act("board", "wait about five minutes, open the agent's Board, and type the runs shown for the ramp as a note. Then press Enter.");
  await ap.stop();
}

const stage = process.argv[2];
if (stage === "setup") await setup(process.argv[3] === "existing");
else if (stage === "run") await run();
else throw new Error("Use: walk setup, or walk run");
lines.close();
