/**
 * The tee: the same telemetry windows that go to AirPrompter, as CloudWatch metrics too.
 *
 * On a serverless host the SDK closes the invocation's windows and POSTs them as one segment under its own upload
 * grant before `invoke()` returns — through the `fetch` port it was started with. `telemetry.uploadSink` is the
 * resident uploader's port and is not consulted on that path (an SDK gap we filed), so the tee sits on the port
 * the flush does use: a fetch that recognises a segment upload (a multipart POST carrying an `application/x-ndjson`
 * part), forwards it untouched, and — only when AirPrompter accepted it — writes each validated window row as one
 * CloudWatch Embedded Metric Format line on stdout. A refused upload emits nothing: the SDK requeues the rows and the
 * next invocation carries them, so a window reaches CloudWatch exactly when it reaches AirPrompter.
 *
 * Dimensions are capped to `tag`, `versionId`, `arm`, `status` (each a small closed set) — a custom metric is billed
 * per unique dimension set, and nothing unbounded ever becomes one. Rows carry no text, so neither do the metrics.
 *
 * @example
 * ```ts
 * const fetch = teeFetch(globalThis.fetch, { namespace: "Zudocs/Desk", emit: (line) => process.stdout.write(line + "\n") });
 * await AirPrompterAgent.start({ ..., sync: { mode: "on_invoke" }, fetch });
 * ```
 */
import { validateSpoolRow, type SpoolRow, type WindowRow } from "@airprompter/agent-sdk";

export interface TeeOptions {
  namespace: string;
  emit: (line: string) => void;
  /** Extra constant properties on every line (searchable in Logs Insights; not dimensions). */
  properties?: Record<string, string>;
}

type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: unknown }) => Promise<{ status: number; text(): Promise<string>; headers?: unknown }>;

/** The NDJSON rows inside a segment upload body, or null when the body is not one. Never throws. */
export function rowsOfUpload(headers: Record<string, string> | undefined, body: unknown): SpoolRow[] | null {
  const contentType = Object.entries(headers ?? {}).find(([name]) => name.toLowerCase() === "content-type")?.[1] ?? "";
  const boundary = /^multipart\/form-data;\s*boundary=(.+)$/i.exec(contentType)?.[1];
  if (!boundary) return null;
  const bytes = body instanceof Uint8Array ? body : typeof body === "string" ? Buffer.from(body, "utf8") : null;
  if (!bytes) return null;
  const text = Buffer.from(bytes).toString("utf8");
  const parts = text.split(`--${boundary}`);
  for (const part of parts) {
    const split = part.indexOf("\r\n\r\n");
    if (split === -1) continue;
    const head = part.slice(0, split);
    if (!/content-type:\s*application\/x-ndjson/i.test(head)) continue;
    let content = part.slice(split + 4);
    if (content.endsWith("\r\n")) content = content.slice(0, -2);
    const rows: SpoolRow[] = [];
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        const verdict = validateSpoolRow(JSON.parse(line));
        if (verdict.ok) rows.push(verdict.row);
      } catch {
        // A line that is not a row is not a metric; the SDK's own validation already refused it upstream.
      }
    }
    return rows;
  }
  return null;
}

const DIMENSIONS = ["tag", "versionId", "arm", "status"] as const;

/** One EMF line per window row; refusal and dropped rows become counts under bounded dimensions. */
export function emfLinesOf(rows: readonly SpoolRow[], namespace: string, properties: Record<string, string> = {}): string[] {
  const lines: string[] = [];
  for (const row of rows) {
    if (row.type === "window") lines.push(windowLine(row, namespace, properties));
    else if (row.type === "refusal") lines.push(JSON.stringify({ _aws: { Timestamp: Date.parse(row.at), CloudWatchMetrics: [{ Namespace: namespace, Dimensions: [["reason"]], Metrics: [{ Name: "refusals", Unit: "Count" }] }] }, reason: row.reason, generation: row.generation, refusals: 1, ...properties }));
    else if (row.type === "dropped") lines.push(JSON.stringify({ _aws: { Timestamp: Date.parse(row.at), CloudWatchMetrics: [{ Namespace: namespace, Dimensions: [[]], Metrics: [{ Name: "droppedSegments", Unit: "Count" }, { Name: "droppedBytes", Unit: "Bytes" }] }] }, droppedSegments: row.segments, droppedBytes: row.bytes, ...properties }));
  }
  return lines;
}

function windowLine(row: WindowRow, namespace: string, properties: Record<string, string>): string {
  const metrics: Array<{ Name: string; Unit?: string }> = [
    { Name: "runs", Unit: "Count" },
    { Name: "latencyMs", Unit: "Milliseconds" },
    { Name: "inputTokens", Unit: "Count" },
    { Name: "outputTokens", Unit: "Count" },
  ];
  const values: Record<string, number> = {
    runs: row.count,
    latencyMs: row.count > 0 ? Math.round(row.latencyMs.sum / row.count) : 0,
    inputTokens: row.tokens.input + (row.tokens.cachedInput ?? 0),
    outputTokens: row.tokens.output,
  };
  if (row.checks) {
    metrics.push({ Name: "checksPassed", Unit: "Count" }, { Name: "checksFailed", Unit: "Count" });
    values.checksPassed = row.checks.passed;
    values.checksFailed = row.checks.failed;
  }
  // Outcome keys are the platform's closed feedback vocabulary (judgeScore, thumbs, accepted, goldenPass, …): bounded.
  for (const [key, outcome] of Object.entries(row.outcomes ?? {})) {
    if (!/^[a-zA-Z][a-zA-Z0-9]{0,31}$/.test(key) || outcome.n <= 0) continue;
    metrics.push({ Name: `outcome_${key}` });
    values[`outcome_${key}`] = outcome.sum / outcome.n;
  }
  return JSON.stringify({
    _aws: { Timestamp: Date.parse(row.minute), CloudWatchMetrics: [{ Namespace: namespace, Dimensions: [[...DIMENSIONS]], Metrics: metrics }] },
    tag: row.tag,
    versionId: row.versionId,
    arm: row.arm,
    status: row.status,
    model: row.model,
    errorClass: row.errorClass,
    usageSource: row.usageSource,
    instanceId: row.instanceId,
    ...values,
    ...properties,
  });
}

/** The fetch the SDK is started with: every request forwarded as is; an accepted segment upload also becomes metrics. */
export function teeFetch<F extends FetchLike>(inner: F, options: TeeOptions): F {
  const tee = async (url: string, init?: Parameters<FetchLike>[1]) => {
    const rows = init?.method?.toUpperCase() === "POST" ? rowsOfUpload(init.headers, init.body) : null;
    const response = await inner(url, init);
    if (rows && rows.length > 0 && response.status >= 200 && response.status < 300) {
      for (const line of emfLinesOf(rows, options.namespace, options.properties)) options.emit(line);
    }
    return response;
  };
  return tee as unknown as F;
}
