/**
 * SDK status plus the digest of its verified active manifest, never the staged or origin release.
 * @example
 * const report = sdkStatus(ap); // safe host metadata for the status table
 */
import type { AirPrompterAgent } from "@airprompter/agent-sdk";

export function sdkStatus(agent: Pick<AirPrompterAgent, "status" | "manifest">) {
  const status = agent.status();
  const active = agent.manifest?.payload;
  return { ...status, releaseDigest: active?.generation === status.generation ? active.releaseDigest : null };
}
