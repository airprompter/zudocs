/**
 * The exchange bucket from the puller's side: the air-gapped host's distribution PUBLIC key (the file
 * `airprompter keygen` wrote, checked — a 32-byte X25519 key whose id matches) and the host's status document.
 * The sealed release is not written here by hand; `pullToDatastore` writes it through the S3 `KvStore` in the
 * SDK's format. A missing object is null, never an error; a malformed one is reported and treated as absent.
 *
 * @example
 * ```ts
 * const exchange = createExchange(s3, "zudocs-exchange-111122223333");
 * const key = await exchange.readPublicKey();          // { keyId, raw } | null (+ a reason when the object is malformed)
 * const { doc } = await exchange.readStatusDoc();      // the host's status/airgap.json, or null
 * ```
 */
import type { S3Client } from "@aws-sdk/client-s3";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { distributionKeyId } from "@airprompter/agent-sdk";
import { parseStatusDoc, type AirgapStatusDoc } from "../../airgap/src/status.js";

/** The exchange's layout (the same constants as `infra/lib/fleet-names.ts`; the puller cannot import the infra package). */
export const EXCHANGE_KEYS = Object.freeze({ publicKey: "keys/airgap.distribution.pub.json", status: "status/airgap.json" });

export interface PublicKeyRead {
  key: { keyId: string; raw: Uint8Array } | null;
  /** Why there is no usable key: `absent`, `denied:<code>` (the read was refused — a misconfiguration, never plaintext), or what is wrong with the object. */
  reason: string | null;
}

/** The public half as the CLI writes it: kind, keyId, base64url key. Pure over the parsed document. */
export function parsePublicKeyFile(document: unknown): { keyId: string; raw: Uint8Array } {
  const file = document as { kind?: unknown; publicKey?: unknown; keyId?: unknown };
  if (file?.kind !== "airprompter-distribution-public-key" || typeof file.publicKey !== "string") throw new Error("not a distribution public key file (kind airprompter-distribution-public-key)");
  const raw = Buffer.from(file.publicKey, "base64url");
  if (raw.length !== 32) throw new Error("publicKey is not a 32-byte X25519 key");
  const keyId = distributionKeyId(raw);
  if (typeof file.keyId === "string" && file.keyId !== keyId) throw new Error("keyId does not match the public key");
  return { keyId, raw };
}

export interface Exchange {
  readPublicKey(): Promise<PublicKeyRead>;
  /** The host's document; `denied` names the refusal when the read was refused (a misconfiguration the card reports). */
  readStatusDoc(): Promise<{ doc: AirgapStatusDoc | null; denied: string | null }>;
}

export function createExchange(s3: Pick<S3Client, "send">, bucket: string): Exchange {
  const send = s3.send.bind(s3) as (command: unknown) => Promise<any>;
  // A missing object is a 404 (the puller's role may list exactly these two keys, which is what makes it a 404 and
  // not a 403). A 403 is a misconfiguration (a bucket policy, an SCP) and is reported as `denied`, never taken for
  // "absent": a puller that cannot see the key must not write plaintext. Anything else is an error.
  const read = async (key: string): Promise<{ text: string | null; denied: string | null }> => {
    try {
      const out = await send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      return { text: out.Body ? await out.Body.transformToString("utf8") : null, denied: null };
    } catch (error) {
      const name = (error as { name?: string }).name ?? "error";
      const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (name === "NoSuchKey" || name === "NotFound" || status === 404) return { text: null, denied: null };
      if (name === "AccessDenied" || status === 403) return { text: null, denied: name };
      throw error;
    }
  };
  return {
    async readPublicKey() {
      const { text, denied } = await read(EXCHANGE_KEYS.publicKey);
      if (denied) return { key: null, reason: `denied:${denied}` };
      if (text === null) return { key: null, reason: "absent" };
      try {
        return { key: parsePublicKeyFile(JSON.parse(text)), reason: null };
      } catch (error) {
        return { key: null, reason: (error as Error).message };
      }
    },
    async readStatusDoc() {
      const { text, denied } = await read(EXCHANGE_KEYS.status);
      if (denied) return { doc: null, denied };
      return { doc: text === null ? null : parseStatusDoc(text), denied: null };
    },
  };
}
