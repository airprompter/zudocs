/**
 * Runs the agent from a shell: one question, or a batch of support traffic, then uploads the counters and stops.
 *
 *   $ set -a; . ~/.config/zudocs/langchain.env; set +a
 *   $ npm run ask -- "Can northwind export to PDF, and how many seats are left?" northwind
 *   $ npm run traffic -- 20
 *   $ npx tsx src/main.ts hold 3600     # a live instance for a person sealing in the console
 *
 * It prints counts and ids only, never prompt text, a reply or a key.
 */

import { ask, buildAgent, startRuntime, type Outcome } from "./agent.js";
import { readConfig } from "./config.js";

const QUESTIONS = [
  ["Can we export to PDF on our plan, and how many editor seats do we have left?", "northwind"],
  ["How long is our version history kept, and are we on a plan that has custom domains?", "acme-docs"],
  ["Our seat count is growing. What plan are we on and what does it allow?", "fabrikam"],
] as const;

const line = (subject: string, outcome: Outcome) =>
  `${subject}: ${outcome.modelCalls} model calls, ${outcome.toolCalls} tool calls, tokens ${outcome.tokensIn} in ${outcome.tokensOut} out, signed ${outcome.signed ? "yes" : "no"}, ${outcome.ms} ms`;

const [command = "ask", first, second] = process.argv.slice(2);
const config = readConfig(process.env);
const ap = await startRuntime(config, console.log);
await ap.syncNow();
const health = ap.healthz();
console.log(`generation ${ap.generation}, health ${health.status} ${JSON.stringify(health.reasons)}, apply ${ap.status().applyState}`);
const agent = buildAgent(ap, config);

if (command === "status") {
  console.log(JSON.stringify({ instanceId: ap.status().instanceId, ramps: ap.status().ramps, lastRefusal: ap.status().lastRefusal }));
} else if (command === "hold") {
  // Stays up so the console sees a live instance and its models while a person seals. Prints each new generation.
  const until = Date.now() + Number(first ?? 3600) * 1000;
  let seen = ap.generation;
  while (Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    if (ap.generation !== seen) console.log(`generation ${(seen = ap.generation)} at ${new Date().toISOString()}, ramps ${ap.status().ramps.length}`);
  }
} else if (command === "ask") {
  const [question, customer] = QUESTIONS[0];
  console.log(line(second ?? customer, await ask(agent, first ?? question, second ?? customer)));
} else if (command === "traffic") {
  const totals = { modelCalls: 0, tokensIn: 0, tokensOut: 0, signed: 0 };
  const requests = Number(first ?? 12);
  for (let index = 0; index < requests; index += 1) {
    const [question, customer] = QUESTIONS[index % QUESTIONS.length]!;
    const subject = `${customer}-${index}`;
    const outcome = await ask(agent, question, customer, subject);
    totals.modelCalls += outcome.modelCalls;
    totals.tokensIn += outcome.tokensIn;
    totals.tokensOut += outcome.tokensOut;
    totals.signed += outcome.signed ? 1 : 0;
    console.log(line(subject, outcome));
  }
  console.log(`totals: ${requests} requests, ${JSON.stringify(totals)}`);
} else {
  throw new Error(`Unknown command ${command}: use status, hold, ask or traffic`);
}

console.log(`upload: ${JSON.stringify(await ap.uploadNow())}`);
await ap.stop();
