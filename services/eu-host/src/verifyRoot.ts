/**
 * The root document the daemon trusts, verified at boot against the pinned key. The released CLI's `daemon`
 * command takes a pinned JWK but drops `--hosted-environment` on the way to the SDK (it passes `{ pinned }` alone,
 * so a dev key is read as prod's and every dev manifest is refused `root_scope_mismatch` — filed upstream), so
 * the host hands the daemon a signed root *document* instead — and only after this check has verified that
 * document against the pinned public key for the hosted environment, exactly as the SDK would have (R1–R5:
 * scope, key ids, version, signatures, expiry). The chain of trust is unchanged: the key in `keys/` vouches for
 * the document, the document vouches for the manifests, rotations after boot are the SDK's.
 *
 * @example
 * ```sh
 * node /opt/zudocs/worker.mjs verify-root /tmp/root.json /etc/airprompter/root.jwk.json dev   # exit 0: version, key ids
 * ```
 */
import { readFileSync } from "node:fs";
import { trustedRootFromPinnedKey, verifyRootMetadata, type P256PublicJwk, type RootMetadata } from "@airprompter/agent-sdk";

export type Target = "dev" | "staging" | "prod";

/** The verdict on a root document against a pinned key: ok with what it names, or the SDK's refusal code. Pure. */
export function verifyRootDocument(candidate: unknown, pinned: unknown, environment: Target, now = new Date().toISOString()): { ok: true; version: number; keyIds: string[]; expires: string } | { ok: false; reason: string } {
  const jwk = pinned as Partial<P256PublicJwk> & { d?: unknown };
  if (!jwk || jwk.kty !== "EC" || jwk.crv !== "P-256" || typeof jwk.x !== "string" || typeof jwk.y !== "string") return { ok: false, reason: "pinned_key_malformed" };
  if (jwk.d !== undefined) return { ok: false, reason: "pinned_key_private" };
  const doc = candidate as Partial<RootMetadata>;
  if (!doc || typeof doc !== "object" || !doc.signed || !Array.isArray(doc.signatures)) return { ok: false, reason: "root_document_malformed" };
  const trusted = trustedRootFromPinnedKey({ purpose: "platform", environment, pinnedRoot: { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y } });
  const verdict = verifyRootMetadata({ candidate: doc as RootMetadata, trusted, now });
  if (!verdict.ok) return { ok: false, reason: verdict.reason };
  return { ok: true, version: doc.signed.version, keyIds: Object.keys(doc.signed.keys), expires: doc.signed.expires };
}

/** The command: paths on argv, one line of JSON on stdout, exit 1 on a refusal (the boot script stops there). */
export function verifyRootCommand(argv: string[]): number {
  const [candidatePath, pinnedPath, environment] = argv;
  if (!candidatePath || !pinnedPath || !["dev", "staging", "prod"].includes(environment ?? "")) {
    process.stderr.write("usage: verify-root <root.json> <pinned.jwk.json> <dev|staging|prod>\n");
    return 2;
  }
  const read = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));
  const verdict = verifyRootDocument(read(candidatePath), read(pinnedPath), environment as Target);
  process.stdout.write(JSON.stringify({ event: "root_verified", ...verdict }) + "\n");
  return verdict.ok ? 0 : 1;
}
