/**
 * Brace-matched slices of the host source, so the desk can show the calls it actually runs.
 * The matcher skips strings, comments, and template literals. A test reads the files and
 * asserts each shipped slice equals what this finds.
 *
 * @example
 * ```ts
 * const slice = extractBalanced(source, "await AirPrompterAgent.start({");
 * ```
 */

/** From `needle` through the `{...}` that starts at its first brace, including a closing `)` and `;` when they follow. */
export function extractBalanced(source: string, needle: string): string {
  const start = source.indexOf(needle);
  if (start < 0) throw new Error(`excerpt: ${needle} is not in the source`);
  const open = source.indexOf("{", start);
  if (open < 0) throw new Error(`excerpt: ${needle} has no brace`);
  let i = open;
  let depth = 0;
  while (i < source.length) {
    const c = source[i]!;
    if (c === "/" && source[i + 1] === "/") {
      const nl = source.indexOf("\n", i);
      i = nl < 0 ? source.length : nl + 1;
      continue;
    }
    if (c === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      if (end < 0) throw new Error("excerpt: unclosed comment");
      i = end + 2;
      continue;
    }
    if (c === "'" || c === "\"") {
      i = skipQuoted(source, i, c);
      continue;
    }
    if (c === "`") {
      i = skipTemplate(source, i);
      continue;
    }
    if (c === "{") depth += 1;
    else if (c === "}") {
      depth -= 1;
      if (depth === 0) {
        let end = i + 1;
        if (source[end] === ")") end += 1;
        if (source[end] === ";") end += 1;
        return source.slice(start, end);
      }
    }
    i += 1;
  }
  throw new Error(`excerpt: ${needle} is unbalanced`);
}

/** The single source line that contains `needle`, without the trailing newline. */
export function extractLine(source: string, needle: string): string {
  const line = source.split("\n").find((row) => row.includes(needle));
  if (!line) throw new Error(`excerpt: no line contains ${needle}`);
  return line;
}

function skipQuoted(source: string, start: number, quote: string): number {
  let i = start + 1;
  while (i < source.length) {
    if (source[i] === "\\") {
      i += 2;
      continue;
    }
    if (source[i] === quote) return i + 1;
    i += 1;
  }
  throw new Error("excerpt: unclosed string");
}

function skipTemplate(source: string, start: number): number {
  let i = start + 1;
  while (i < source.length) {
    if (source[i] === "\\") {
      i += 2;
      continue;
    }
    if (source[i] === "`") return i + 1;
    if (source[i] === "$" && source[i + 1] === "{") {
      const inner = extractBalanced(source.slice(i + 1), "{");
      i = i + 1 + inner.length;
      continue;
    }
    i += 1;
  }
  throw new Error("excerpt: unclosed template");
}

export type MarkKind = "write" | "host";

export interface Mark { needle: string; kind: MarkKind }

/** Split `text` so each mark's needle can be wrapped. Needles that miss stay unmarked. */
export function splitMarks(text: string, marks: readonly Mark[]): Array<{ text: string; kind: MarkKind | null }> {
  const found = marks
    .map((mark) => ({ ...mark, at: text.indexOf(mark.needle) }))
    .filter((mark) => mark.at >= 0)
    .sort((a, b) => a.at - b.at);
  const parts: Array<{ text: string; kind: MarkKind | null }> = [];
  let cursor = 0;
  for (const mark of found) {
    if (mark.at < cursor) continue;
    if (mark.at > cursor) parts.push({ text: text.slice(cursor, mark.at), kind: null });
    parts.push({ text: text.slice(mark.at, mark.at + mark.needle.length), kind: mark.kind });
    cursor = mark.at + mark.needle.length;
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor), kind: null });
  if (parts.length === 0) parts.push({ text, kind: null });
  return parts;
}
