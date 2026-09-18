#!/usr/bin/env node
/**
 * `keys/` may hold public JWKs only. A JWK with a private member (`d` for
 * EC/OKP, `p`/`q`/`dp`/`dq`/`qi` for RSA, `k` for a symmetric key) fails the
 * check, as does any file there that is not JSON. Runs in CI and before a push.
 *
 *   $ node scripts/check-keys.mjs        # exit 1 and the file name when a private member is found
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = join(fileURLToPath(new URL(".", import.meta.url)), "..", "keys");
const PRIVATE = ["d", "p", "q", "dp", "dq", "qi", "k", "oth"];
let bad = 0;
for (const name of readdirSync(dir)) {
  if (name === "README.md") continue;
  const path = join(dir, name);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    console.log(`FAIL keys/${name}: not JSON`);
    bad += 1;
    continue;
  }
  const keys = Array.isArray(parsed?.keys) ? parsed.keys : [parsed];
  for (const jwk of keys) {
    const found = PRIVATE.filter((m) => jwk && typeof jwk === "object" && m in jwk);
    if (found.length) {
      console.log(`FAIL keys/${name}: private member(s) ${found.join(", ")} — this is a private key, never commit it`);
      bad += 1;
    }
  }
}
console.log(`check-keys: ${bad === 0 ? "ok" : `${bad} problem(s)`}`);
process.exit(bad === 0 ? 0 : 1);
