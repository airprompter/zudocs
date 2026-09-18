/**
 * The exchange bucket from the puller's side: the air-gapped host's distribution PUBLIC key (the file
 * `airprompter keygen` wrote, checked — a 32-byte X25519 key whose id matches), the host's status document, and
 * the two things the puller writes — a sealed bundle under `releases/` and the `latest.json` pointer. A missing
 * object is null, never an error; a malformed one is reported and treated as absent.
 *
 * @example
 * ```ts
 * const exchange = createExchange(s3, "zudocs-exchange-111122223333");
 * const key = await exchange.readPublicKey();          // { keyId, raw } | null (+ a reason when the object is malformed)
 * await exchange.writeBundle("releases/3-ab12cd34.apbundle", JSON.stringify(bundle));
 * await exchange.writeLatest({ generation: 3, releaseDigest, keyId, object, pulledAt });
 * ```
 */
import type { S3Client } from "@aws-sdk/client-s3";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { distributionKeyId } from "@airprompter/agent-sdk";
import { parseStatusDoc, type AirgapStatusDoc } from "../../airgap/src/status.js";

/** The exchange's layout (the same constants as `infra/lib/fleet-names.ts`; the puller cannot import the infra package). */
export const EXCHANGE_KEYS = Object.freeze({ releasesPrefix: "releases/", latest: "latest.json", publicKey: "keys/airgap.distribution.pub.json", status: "status/airgap.json" });

export interface PublicKeyRead {
  key: { keyId: string; raw: Uint8Array } | null;
  /** Why there is no usable key: absent, or what is wrong with the object. */
  reason: string | null;
}

export interface LatestPointer {
  generation: number;
  releaseDigest: string;
  keyId: string | null;
  object: string;
  pulledAt: string;
  notAfter: string;
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
  readStatusDoc(): Promise<AirgapStatusDoc | null>;
  writeBundle(key: string, text: string, metadata: Record<string, string>): Promise<void>;
  writeLatest(pointer: LatestPointer): Promise<void>;
}

export function createExchange(s3: Pick<S3Client, "send">, bucket: string): Exchange {
  const send = s3.send.bind(s3) as (command: unknown) => Promise<any>;
  // A missing object is a 404 when the caller may list the key (the puller's role may, for these two keys) and a
  // 403 otherwise; both mean "not there" for an object the host writes when it exists. Anything else is an error.
  const read = async (key: string): Promise<string | null> => {
    try {
      const out = await send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      return out.Body ? await out.Body.transformToString("utf8") : null;
    } catch (error) {
      const name = (error as { name?: string }).name;
      const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (name === "NoSuchKey" || name === "NotFound" || status === 404 || name === "AccessDenied" || status === 403) return null;
      throw error;
    }
  };
  return {
    async readPublicKey() {
      const text = await read(EXCHANGE_KEYS.publicKey);
      if (text === null) return { key: null, reason: "absent" };
      try {
        return { key: parsePublicKeyFile(JSON.parse(text)), reason: null };
      } catch (error) {
        return { key: null, reason: (error as Error).message };
      }
    },
    async readStatusDoc() {
      const text = await read(EXCHANGE_KEYS.status);
      return text === null ? null : parseStatusDoc(text);
    },
    async writeBundle(key, text, metadata) {
      await send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: text, ContentType: "application/json", Metadata: metadata }));
    },
    async writeLatest(pointer) {
      await send(new PutObjectCommand({ Bucket: bucket, Key: EXCHANGE_KEYS.latest, Body: JSON.stringify(pointer), ContentType: "application/json", CacheControl: "no-store" }));
    },
  };
}
