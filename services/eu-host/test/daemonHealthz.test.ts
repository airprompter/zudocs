/**
 * The raw healthz reader against a fake daemon on a Unix socket that speaks the daemon's JSON-lines protocol and
 * reproduces the released daemon's reply shape: the healthz document spliced into the envelope, its own `ok: false`
 * when the host is failing. The reader takes the document either way, refuses a reply that carries no document,
 * and answers null on an absent socket, a refused hello, or a silent daemon.
 *
 * @example
 * ```sh
 * npx tsx --test test/daemonHealthz.test.ts
 * ```
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readDaemonHealthz } from "../src/daemonHealthz.js";

function fakeDaemon(answer: (op: string, id: string) => Record<string, unknown> | null): { path: string; server: Server; close: () => Promise<void> } {
  const path = join(mkdtempSync(join(tmpdir(), "zudocs-daemon-")), "d.sock");
  const server = createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const request = JSON.parse(line) as { id: string; op: string };
        const reply = answer(request.op, request.id);
        if (reply) socket.write(`${JSON.stringify({ id: request.id, ...reply })}\n`);
      }
    });
  });
  return { path, server, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

const FAILING = { ok: false, status: "failing", reasons: ["no_verified_release"], generation: 0, stagedGeneration: 1, applyState: "awaiting_unlock", spool: { depthSegments: 0, depthBytes: 0, budgetBytes: 1 } };

test("a failing host's healthz (the document's ok:false inside the envelope) is read as the document, exactly what the SDK's client refuses", async () => {
  const d = fakeDaemon((op) => (op === "hello" ? { ok: true, daemon: "fake/0", generation: 0, stagedGeneration: 1 } : op === "healthz" ? FAILING : null));
  await new Promise<void>((resolve) => d.server.listen(d.path, resolve));
  const healthz = await readDaemonHealthz(d.path);
  assert.deepEqual(healthz, FAILING);
  await d.close();
});

test("a healthy host's healthz comes back whole; a reply with no document, a refused hello, a silent daemon and an absent socket answer null", async () => {
  const OK = { ok: true, status: "ok", reasons: [], generation: 2, stagedGeneration: null, applyState: "active", spool: { depthSegments: 0, depthBytes: 0, budgetBytes: 1 } };
  const healthy = fakeDaemon((op) => (op === "hello" ? { ok: true } : OK));
  await new Promise<void>((resolve) => healthy.server.listen(healthy.path, resolve));
  assert.deepEqual(await readDaemonHealthz(healthy.path), OK);
  await healthy.close();
  const refusing = fakeDaemon((op) => (op === "hello" ? { ok: true } : { ok: false, error: "no such op" }));
  await new Promise<void>((resolve) => refusing.server.listen(refusing.path, resolve));
  assert.equal(await readDaemonHealthz(refusing.path), null, "a refusal is not a document");
  await refusing.close();
  const noHello = fakeDaemon(() => ({ ok: false, error: "scope_mismatch" }));
  await new Promise<void>((resolve) => noHello.server.listen(noHello.path, resolve));
  assert.equal(await readDaemonHealthz(noHello.path), null);
  await noHello.close();
  const silent = fakeDaemon(() => null);
  await new Promise<void>((resolve) => silent.server.listen(silent.path, resolve));
  assert.equal(await readDaemonHealthz(silent.path, 300), null, "the timeout answers null");
  await silent.close();
  assert.equal(await readDaemonHealthz(join(tmpdir(), "zudocs-nowhere.sock")), null);
});
