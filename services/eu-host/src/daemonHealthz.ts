/**
 * The daemon's `healthz` document, read over its socket without the SDK's client. The daemon answers that op with
 * the document spliced into the reply envelope, and the document carries its own `ok` — `false` whenever the host
 * is failing (nothing verified, a lapsed lease under halt) — which the SDK's `DaemonClient` reads as a refused
 * request and throws. So exactly when the desk most needs the daemon's word (a fresh host with nothing active), the
 * client cannot carry it (filed upstream). This reads the same line the client would, and takes the reply as the
 * document when it has a `status`. One connection per read; the protocol is JSON lines with a string `id`.
 *
 * @example
 * ```ts
 * const healthz = await readDaemonHealthz(socketPath);   // { ok: false, status: "failing", reasons: ["no_verified_release"], … } or null
 * ```
 */
import { connect } from "node:net";
import type { Healthz } from "@airprompter/agent-sdk";

export function readDaemonHealthz(socketPath: string, timeoutMs = 3000): Promise<(Healthz & Record<string, unknown>) | null> {
  return new Promise((resolve) => {
    const socket = connect(socketPath);
    let buffer = "";
    let done = false;
    const finish = (value: (Healthz & Record<string, unknown>) | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    socket.on("error", () => finish(null));
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ id: "hello", op: "hello", sdk: "zudocs-worker/healthz" })}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        let reply: Record<string, unknown>;
        try {
          reply = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (reply.id === "hello") {
          if (reply.ok !== true) return finish(null);
          socket.write(`${JSON.stringify({ id: "healthz", op: "healthz" })}\n`);
        } else if (reply.id === "healthz") {
          // The document, when the reply carries one (its own `ok` is the liveness answer); a refusal carries `error`.
          if (typeof reply.status === "string" && Array.isArray(reply.reasons)) {
            const { id: _id, ...doc } = reply;
            return finish(doc as Healthz & Record<string, unknown>);
          }
          return finish(null);
        }
      }
    });
    socket.on("close", () => finish(null));
  });
}
