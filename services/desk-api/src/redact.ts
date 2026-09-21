/**
 * The key-shaped scan the strips already run (`scripts/strip.sh` › `scan`), as a function: anything that looks like an
 * AirPrompter key or session token (`apa_…`, `apr_…`, a JWT's `eyJ…`), a bearer header, an environment dump of a
 * key variable, a PEM private key or a JWK's private member is replaced with `[redacted]` before the text is stored
 * or shown. The CLI prints none of these at any verbosity, so a hit is a bug on the host — the timeline row says so
 * instead of carrying it. Pure; no false negatives are claimed, only that the strips' patterns and the desk's are one.
 *
 * @example
 * ```ts
 * redactKeyShaped('{"ok":true,"token":"apa_abcdef123456"}');   // { text: '{"ok":true,"token":"[redacted]"}', hits: 1 }
 * redactKeyShaped("in force: unlock_required (local)");          // { text: "in force: unlock_required (local)", hits: 0 }
 * ```
 */

export const REDACTED = "[redacted]";

/** The strips' patterns (`strip.sh`), plus the two the review named: a bearer header and an AWS session token. A JWK's private member keeps its name so a JSON document still parses. */
export const KEY_SHAPED: ReadonlyArray<{ readonly pattern: RegExp; readonly replacement: string }> = Object.freeze([
  // The named forms first (a variable, a header), so the bare token inside them is one hit, not two.
  { pattern: /AIRPROMPTER_AGENT_KEY=\S*/g, replacement: `AIRPROMPTER_AGENT_KEY=${REDACTED}` },
  { pattern: /AIRPROMPTER_SESSION_TOKEN=\S*/g, replacement: `AIRPROMPTER_SESSION_TOKEN=${REDACTED}` },
  { pattern: /AWS_SECRET_ACCESS_KEY=?\S*/g, replacement: `AWS_SECRET_ACCESS_KEY=${REDACTED}` },
  { pattern: /AWS_SESSION_TOKEN=\S*/g, replacement: `AWS_SESSION_TOKEN=${REDACTED}` },
  { pattern: /Bearer\s+[A-Za-z0-9._~+/=-]{16,}/g, replacement: `Bearer ${REDACTED}` },
  { pattern: /apa_[A-Za-z0-9_]{6,}/g, replacement: REDACTED },
  { pattern: /apr_[A-Za-z0-9_]{6,}/g, replacement: REDACTED },
  { pattern: /eyJ[A-Za-z0-9_-]{20,}(?:\.[A-Za-z0-9_-]+)*/g, replacement: REDACTED },
  { pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, replacement: REDACTED },
  { pattern: /"d"\s*:\s*"[^"]*"/g, replacement: `"d":"${REDACTED}"` },
]);

/** Every key-shaped span replaced; `hits` counts them. Pure. */
export function redactKeyShaped(text: string): { text: string; hits: number } {
  let hits = 0;
  let out = text;
  for (const { pattern, replacement } of KEY_SHAPED) {
    out = out.replace(new RegExp(pattern.source, pattern.flags), () => {
      hits += 1;
      return replacement;
    });
  }
  return { text: out, hits };
}
