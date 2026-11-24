/**
 * Bounded, strict subset YAML parser for `orca.yaml` worktree hook configs.
 *
 * Supports block/flow mappings, block/multiline-flow sequences, quoted and
 * plain scalars, and literal (`|`) / folded (`>`) block scalars within
 * explicit size and nesting limits. Rejects anchors/aliases (`&`/`*`), tags,
 * duplicate mapping keys, tab indentation, invalid double-quoted escapes, and
 * non-mapping roots so unsupported or malformed configs fail loudly as
 * `invalid_orca_yaml` rather than producing a false-clean audit.
 */

export const MAX_ORCA_YAML_BYTES = 256 * 1024;
export const MAX_ORCA_YAML_DEPTH = 16;

export interface ParsedOrcaYaml {
  readonly setupCommand: string | null;
  readonly archiveCommand: string | null;
  readonly sharedDirectories: readonly string[];
}

type YamlScalar = string | number | boolean | null;

type YamlValue =
  | YamlScalar
  | readonly YamlValue[]
  | { readonly [key: string]: YamlValue };

interface LineCursor {
  readonly lines: readonly string[];
  index: number;
}

function hasLeadingTab(line: string): boolean {
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "\t") return true;
    if (ch !== " ") return false;
  }
  return false;
}

function getIndent(line: string): number {
  let indent = 0;
  while (indent < line.length && line[indent] === " ") {
    indent++;
  }
  return indent;
}

function stripYamlComment(line: string): string {
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inDouble && ch === "\\") {
      escaped = true;
      continue;
    }
    if (!inDouble && ch === "'") {
      inSingle = !inSingle;
      continue;
    }
    if (!inSingle && ch === '"') {
      inDouble = !inDouble;
      continue;
    }
    if (!inSingle && !inDouble && ch === "#" && (i === 0 || /\s/.test(line[i - 1] ?? ""))) {
      return line.slice(0, i);
    }
  }
  return line;
}

function isBlankOrComment(line: string): boolean {
  return stripYamlComment(line).trim().length === 0;
}

function skipBlankLines(cursor: LineCursor): boolean {
  while (cursor.index < cursor.lines.length) {
    const line = cursor.lines[cursor.index] ?? "";
    if (hasLeadingTab(line)) {
      // Tab indentation is invalid unless the entire line is whitespace/comment-free?
      // YAML forbids tabs in indentation on any content line; blank lines with tabs are rejected if non-empty.
      if (line.trim().length > 0) return false;
    }
    if (!isBlankOrComment(line)) break;
    cursor.index++;
  }
  return true;
}

const SIMPLE_ESCAPES: Record<string, string> = {
  "0": "\0",
  a: "\x07",
  b: "\b",
  t: "\t",
  "\t": "\t",
  n: "\n",
  v: "\v",
  f: "\f",
  r: "\r",
  e: "\x1b",
  " ": " ",
  '"': '"',
  "/": "/",
  "\\": "\\",
  N: "\u0085",
  _: "\u00a0",
  L: "\u2028",
  P: "\u2029",
};

function parseDoubleQuotedScalar(trimmed: string): { ok: true; value: string } | { ok: false } {
  if (trimmed.length < 2 || !trimmed.startsWith('"') || !trimmed.endsWith('"')) {
    return { ok: false };
  }
  let out = "";
  for (let i = 1; i < trimmed.length - 1; i++) {
    const ch = trimmed[i] ?? "";
    if (ch === '"') {
      // Unescaped quote before closing position (e.g. trailing garbage `"a" "b"`)
      return { ok: false };
    }
    const code = ch.charCodeAt(0);
    if (code < 0x20 && ch !== "\t" && ch !== "\n") {
      return { ok: false };
    }
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    i++;
    if (i >= trimmed.length - 1) return { ok: false };
    const esc = trimmed[i] ?? "";
    if (esc === "\n") {
      while (i + 1 < trimmed.length - 1 && (trimmed[i + 1] === " " || trimmed[i + 1] === "\t")) {
        i++;
      }
      continue;
    }
    const mapped = SIMPLE_ESCAPES[esc];
    if (mapped !== undefined) {
      out += mapped;
      continue;
    }
    if (esc === "x" || esc === "u" || esc === "U") {
      const hexLen = esc === "x" ? 2 : esc === "u" ? 4 : 8;
      const hex = trimmed.slice(i + 1, i + 1 + hexLen);
      if (hex.length !== hexLen || !/^[0-9a-fA-F]+$/.test(hex)) {
        return { ok: false };
      }
      const cp = Number.parseInt(hex, 16);
      if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) {
        return { ok: false };
      }
      out += String.fromCodePoint(cp);
      i += hexLen;
      continue;
    }
    return { ok: false };
  }
  return { ok: true, value: out };
}

function parseSingleQuotedScalar(trimmed: string): { ok: true; value: string } | { ok: false } {
  if (trimmed.length < 2 || !trimmed.startsWith("'") || !trimmed.endsWith("'")) {
    return { ok: false };
  }
  let out = "";
  for (let i = 1; i < trimmed.length - 1; i++) {
    const ch = trimmed[i] ?? "";
    if (ch === "'") {
      if (i + 1 < trimmed.length - 1 && trimmed[i + 1] === "'") {
        out += "'";
        i++;
        continue;
      }
      return { ok: false };
    }
    out += ch;
  }
  return { ok: true, value: out };
}

function hasDisallowedScalarPrefix(trimmed: string): boolean {
  const first = trimmed[0] ?? "";
  return (
    first === "&" ||
    first === "*" ||
    first === "!" ||
    first === "[" ||
    first === "{" ||
    first === "]" ||
    first === "}" ||
    first === "," ||
    first === "@" ||
    first === "`" ||
    first === "|" ||
    first === ">" ||
    trimmed === "-" ||
    /^-\s/.test(trimmed) ||
    trimmed === "?" ||
    /^\?\s/.test(trimmed) ||
    trimmed === ":" ||
    /^:\s/.test(trimmed)
  );
}

function parsePlainYaml12Scalar(trimmed: string): YamlScalar {
  if (trimmed === "~" || trimmed === "null" || trimmed === "Null" || trimmed === "NULL") {
    return null;
  }
  if (trimmed === "true" || trimmed === "True" || trimmed === "TRUE") {
    return true;
  }
  if (trimmed === "false" || trimmed === "False" || trimmed === "FALSE") {
    return false;
  }
  if (/^[-+]?[0-9]+$/.test(trimmed)) {
    return Number(trimmed);
  }
  if (/^0o[0-7]+$/.test(trimmed)) {
    return Number.parseInt(trimmed.slice(2), 8);
  }
  if (/^0x[0-9a-fA-F]+$/.test(trimmed)) {
    return Number.parseInt(trimmed.slice(2), 16);
  }
  if (/^[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)(?:[eE][-+]?[0-9]+)?$/.test(trimmed)) {
    return Number(trimmed);
  }
  if (/^[-+]?\.(?:inf|Inf|INF)$/.test(trimmed)) {
    return trimmed.startsWith("-") ? -Infinity : Infinity;
  }
  if (/^\.(?:nan|NaN|NAN)$/.test(trimmed)) {
    return Number.NaN;
  }
  return trimmed;
}

function parseYamlScalar(raw: string): { ok: true; value: YamlScalar } | { ok: false } {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { ok: true, value: null };
  }
  if (trimmed.startsWith('"')) {
    return parseDoubleQuotedScalar(trimmed);
  }
  if (trimmed.startsWith("'")) {
    return parseSingleQuotedScalar(trimmed);
  }
  if (hasDisallowedScalarPrefix(trimmed)) {
    return { ok: false };
  }
  if (/:\s/.test(trimmed) || trimmed.endsWith(":")) {
    return { ok: false };
  }
  return { ok: true, value: parsePlainYaml12Scalar(trimmed) };
}

function splitMappingKeyValue(trimmed: string): { keyRaw: string; restRaw: string } | null {
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i] ?? "";
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inDouble && ch === "\\") {
      escaped = true;
      continue;
    }
    if (!inDouble && ch === "'") {
      inSingle = !inSingle;
      continue;
    }
    if (!inSingle && ch === '"') {
      inDouble = !inDouble;
      continue;
    }
    if (!inSingle && !inDouble && ch === ":") {
      const next = trimmed[i + 1];
      const keyRaw = trimmed.slice(0, i);
      const isQuotedKey =
        (keyRaw.trim().startsWith('"') && keyRaw.trim().endsWith('"')) ||
        (keyRaw.trim().startsWith("'") && keyRaw.trim().endsWith("'"));
      if (next === undefined || /\s/.test(next) || (isQuotedKey && (next === "[" || next === "{"))) {
        return {
          keyRaw,
          restRaw: trimmed.slice(i + 1),
        };
      }
    }
  }
  return null;
}

function parseBlockScalarHeader(
  trimmed: string,
): { style: "|" | ">"; chomp: "" | "-" | "+"; explicitIndent: number | null } | null {
  const m = /^([|>])(?:([+-])([1-9])?|([1-9])([+-])?)?$/.exec(trimmed);
  if (!m) return null;
  const style = m[1] as "|" | ">";
  const chomp = (m[2] ?? m[5] ?? "") as "" | "-" | "+";
  const indentDigits = m[3] ?? m[4];
  const explicitIndent = indentDigits ? Number.parseInt(indentDigits, 10) : null;
  return { style, chomp, explicitIndent };
}

function parseBlockScalar(
  cursor: LineCursor,
  header: { style: "|" | ">"; chomp: "" | "-" | "+"; explicitIndent: number | null },
  parentIndent: number,
): string {
  cursor.index++;
  let contentIndent =
    header.explicitIndent !== null ? parentIndent + header.explicitIndent : null;
  const rawContentLines: string[] = [];

  while (cursor.index < cursor.lines.length) {
    const line = cursor.lines[cursor.index] ?? "";
    const isWhitespaceOnly = line.trim().length === 0;
    const indent = getIndent(line);

    if (isWhitespaceOnly) {
      if (contentIndent === null) {
        rawContentLines.push("");
      } else {
        rawContentLines.push(line.length > contentIndent ? line.slice(contentIndent) : "");
      }
      cursor.index++;
      continue;
    }

    if (contentIndent === null) {
      if (indent <= parentIndent) {
        break;
      }
      contentIndent = indent;
    } else if (indent < contentIndent) {
      break;
    }

    rawContentLines.push(line.slice(contentIndent));
    cursor.index++;
  }

  let trailingEmptyCount = 0;
  for (let i = rawContentLines.length - 1; i >= 0; i--) {
    if ((rawContentLines[i] ?? "") === "") trailingEmptyCount++;
    else break;
  }

  const bodyLines = rawContentLines.slice(0, rawContentLines.length - trailingEmptyCount);
  if (bodyLines.length === 0) {
    return header.chomp === "+" ? "\n".repeat(trailingEmptyCount) : "";
  }

  let body: string;
  if (header.style === "|") {
    body = bodyLines.join("\n");
  } else {
    const parts: string[] = [];
    for (let i = 0; i < bodyLines.length; i++) {
      const line = bodyLines[i] ?? "";
      if (i === 0) {
        parts.push(line);
      } else if (line === "") {
        parts.push("\n");
      } else if ((bodyLines[i - 1] ?? "") === "") {
        parts.push(line);
      } else {
        parts.push(` ${line}`);
      }
    }
    body = parts.join("");
  }

  if (header.chomp === "-") return body;
  if (header.chomp === "+") return `${body}${"\n".repeat(1 + trailingEmptyCount)}`;
  return `${body}\n`;
}

function collectFlowText(
  cursor: LineCursor,
  initialRest: string,
  baseDepth: number,
): string | null {
  const stack: Array<"[" | "{"> = [];
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  const collected: string[] = [];

  let segment = initialRest.trimStart();
  while (true) {
    let lineOut = "";
    let closedAt: number | null = null;

    for (let i = 0; i < segment.length; i++) {
      const ch = segment[i] ?? "";
      if (escaped) {
        lineOut += ch;
        escaped = false;
        continue;
      }
      if (inDouble && ch === "\\") {
        lineOut += ch;
        escaped = true;
        continue;
      }
      if (!inDouble && ch === "'") {
        inSingle = !inSingle;
        lineOut += ch;
        continue;
      }
      if (!inSingle && ch === '"') {
        inDouble = !inDouble;
        lineOut += ch;
        continue;
      }
      if (!inSingle && !inDouble) {
        if (ch === "#" && (i === 0 || /\s/.test(segment[i - 1] ?? ""))) {
          break;
        }
        if (ch === "[" || ch === "{") {
          stack.push(ch);
          if (baseDepth + stack.length > MAX_ORCA_YAML_DEPTH) {
            return null;
          }
        } else if (ch === "]" || ch === "}") {
          const expected = ch === "]" ? "[" : "{";
          if (stack.pop() !== expected) {
            return null;
          }
          if (stack.length === 0) {
            lineOut += ch;
            closedAt = i;
            break;
          }
        }
      }
      lineOut += ch;
    }

    collected.push(lineOut);

    if (closedAt !== null) {
      const remainder = stripYamlComment(segment.slice(closedAt + 1)).trim();
      if (remainder.length > 0) {
        return null;
      }
      cursor.index++;
      return collected.join("\n");
    }

    cursor.index++;
    if (cursor.index >= cursor.lines.length) {
      return null;
    }
    const nextLine = cursor.lines[cursor.index] ?? "";
    if (!inSingle && !inDouble && hasLeadingTab(nextLine) && nextLine.trim().length > 0) {
      return null;
    }
    segment = nextLine;
  }
}

function splitFlowTopLevel(inner: string): string[] | null {
  const parts: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  const stack: Array<"[" | "{"> = [];

  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i] ?? "";
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (inDouble && ch === "\\") {
      current += ch;
      escaped = true;
      continue;
    }
    if (!inDouble && ch === "'") {
      inSingle = !inSingle;
      current += ch;
      continue;
    }
    if (!inSingle && ch === '"') {
      inDouble = !inDouble;
      current += ch;
      continue;
    }
    if (!inSingle && !inDouble) {
      if (ch === "[" || ch === "{") {
        stack.push(ch);
      } else if (ch === "]" || ch === "}") {
        const expected = ch === "]" ? "[" : "{";
        if (stack.pop() !== expected) return null;
      } else if (ch === "," && stack.length === 0) {
        if (current.trim().length === 0) return null;
        parts.push(current);
        current = "";
        continue;
      }
    }
    current += ch;
  }

  if (inSingle || inDouble || stack.length > 0) return null;
  if (current.trim().length > 0) {
    parts.push(current);
  }
  return parts;
}

function parseFlowValue(raw: string, depth: number): { ok: true; value: YamlValue } | { ok: false } {
  if (depth > MAX_ORCA_YAML_DEPTH) return { ok: false };
  const trimmed = raw.trim();
  if (!trimmed) return { ok: true, value: null };

  if (trimmed.startsWith("[")) {
    if (!trimmed.endsWith("]")) return { ok: false };
    const inner = trimmed.slice(1, -1).trim();
    if (!inner) return { ok: true, value: [] };
    const parts = splitFlowTopLevel(inner);
    if (!parts) return { ok: false };
    const items: YamlValue[] = [];
    for (const part of parts) {
      const parsed = parseFlowValue(part, depth + 1);
      if (!parsed.ok) return { ok: false };
      items.push(parsed.value);
    }
    return { ok: true, value: items };
  }

  if (trimmed.startsWith("{")) {
    if (!trimmed.endsWith("}")) return { ok: false };
    const inner = trimmed.slice(1, -1).trim();
    if (!inner) return { ok: true, value: {} };
    const parts = splitFlowTopLevel(inner);
    if (!parts) return { ok: false };
    const map: Record<string, YamlValue> = {};
    const seen = new Set<string>();
    for (const part of parts) {
      const split = splitMappingKeyValue(part.trim());
      if (!split) return { ok: false };
      const keyParsed = parseYamlScalar(split.keyRaw);
      if (!keyParsed.ok || typeof keyParsed.value !== "string") return { ok: false };
      if (seen.has(keyParsed.value)) return { ok: false };
      seen.add(keyParsed.value);
      const valParsed = parseFlowValue(split.restRaw, depth + 1);
      if (!valParsed.ok) return { ok: false };
      map[keyParsed.value] = valParsed.value;
    }
    return { ok: true, value: map };
  }

  return parseYamlScalar(trimmed);
}

function isSequenceIndicator(trimmed: string): boolean {
  return trimmed === "-" || /^-\s/.test(trimmed);
}

function parseBlockValueForEmptyRest(
  cursor: LineCursor,
  parentIndent: number,
  depth: number,
): { ok: true; value: YamlValue } | { ok: false } {
  if (!skipBlankLines(cursor)) return { ok: false };
  if (cursor.index >= cursor.lines.length) {
    return { ok: true, value: null };
  }
  const nextLine = cursor.lines[cursor.index] ?? "";
  if (hasLeadingTab(nextLine)) return { ok: false };
  const nextIndent = getIndent(nextLine);
  const nextTrimmed = stripYamlComment(nextLine).trim();
  if (nextIndent === 0 && (nextTrimmed === "---" || nextTrimmed === "...")) {
    return { ok: true, value: null };
  }
  if (nextIndent < parentIndent) {
    return { ok: true, value: null };
  }
  if (nextIndent === parentIndent) {
    if (isSequenceIndicator(nextTrimmed)) {
      return parseBlockSequence(cursor, nextIndent, depth + 1);
    }
    return { ok: true, value: null };
  }
  if (isSequenceIndicator(nextTrimmed)) {
    return parseBlockSequence(cursor, nextIndent, depth + 1);
  }
  return parseBlockMapping(cursor, nextIndent, depth + 1);
}

function parseInlineOrChildValue(
  cursor: LineCursor,
  restRaw: string,
  parentIndent: number,
  depth: number,
): { ok: true; value: YamlValue } | { ok: false } {
  const restTrimmed = restRaw.trim();
  if (!restTrimmed) {
    cursor.index++;
    return parseBlockValueForEmptyRest(cursor, parentIndent, depth);
  }
  const blockHeader = parseBlockScalarHeader(restTrimmed);
  if (blockHeader) {
    return { ok: true, value: parseBlockScalar(cursor, blockHeader, parentIndent) };
  }
  if (restTrimmed.startsWith("[") || restTrimmed.startsWith("{")) {
    const flowText = collectFlowText(cursor, restTrimmed, depth);
    if (flowText === null) return { ok: false };
    return parseFlowValue(flowText, depth + 1);
  }
  cursor.index++;
  return parseYamlScalar(restTrimmed);
}

function parseBlockSequence(
  cursor: LineCursor,
  expectedIndent: number,
  depth: number,
): { ok: true; value: YamlValue[] } | { ok: false } {
  if (depth > MAX_ORCA_YAML_DEPTH) return { ok: false };
  const items: YamlValue[] = [];

  while (cursor.index < cursor.lines.length) {
    if (!skipBlankLines(cursor)) return { ok: false };
    if (cursor.index >= cursor.lines.length) break;

    const line = cursor.lines[cursor.index] ?? "";
    if (hasLeadingTab(line)) return { ok: false };
    const indent = getIndent(line);
    const trimmed = stripYamlComment(line).trim();
    if (indent === 0 && (trimmed === "---" || trimmed === "...")) break;
    if (indent < expectedIndent) break;
    if (indent > expectedIndent) return { ok: false };
    if (!isSequenceIndicator(trimmed)) break;

    const afterDash = trimmed.slice(1);
    const afterDashTrimmed = afterDash.trim();

    if (!afterDashTrimmed) {
      cursor.index++;
      if (!skipBlankLines(cursor)) return { ok: false };
      if (cursor.index >= cursor.lines.length) {
        items.push(null);
        break;
      }
      const nextLine = cursor.lines[cursor.index] ?? "";
      if (hasLeadingTab(nextLine)) return { ok: false };
      const nextIndent = getIndent(nextLine);
      const nextTrimmed = stripYamlComment(nextLine).trim();
      if (nextIndent <= expectedIndent || (nextIndent === 0 && (nextTrimmed === "---" || nextTrimmed === "..."))) {
        items.push(null);
      } else if (isSequenceIndicator(nextTrimmed)) {
        const sub = parseBlockSequence(cursor, nextIndent, depth + 1);
        if (!sub.ok) return { ok: false };
        items.push(sub.value);
      } else {
        const sub = parseBlockMapping(cursor, nextIndent, depth + 1);
        if (!sub.ok) return { ok: false };
        items.push(sub.value);
      }
      continue;
    }

    const leadingAfterDash = afterDash.length - afterDash.trimStart().length;
    const itemInlineIndent = expectedIndent + 1 + leadingAfterDash;
    const inlineMapSplit = splitMappingKeyValue(afterDashTrimmed);
    if (inlineMapSplit) {
      // Inline mapping item `- key: value` (possibly followed by sibling keys at itemInlineIndent)
      const firstKeyParsed = parseYamlScalar(inlineMapSplit.keyRaw);
      if (!firstKeyParsed.ok || typeof firstKeyParsed.value !== "string") return { ok: false };
      const firstVal = parseInlineOrChildValue(
        cursor,
        inlineMapSplit.restRaw,
        itemInlineIndent,
        depth + 1,
      );
      if (!firstVal.ok) return { ok: false };
      const itemMap: Record<string, YamlValue> = { [firstKeyParsed.value]: firstVal.value };
      const seen = new Set<string>([firstKeyParsed.value]);

      if (!skipBlankLines(cursor)) return { ok: false };
      if (cursor.index < cursor.lines.length) {
        const siblingLine = cursor.lines[cursor.index] ?? "";
        if (hasLeadingTab(siblingLine)) return { ok: false };
        if (getIndent(siblingLine) === itemInlineIndent && !isSequenceIndicator(stripYamlComment(siblingLine).trim())) {
          const restMap = parseBlockMapping(cursor, itemInlineIndent, depth + 1, seen);
          if (!restMap.ok) return { ok: false };
          Object.assign(itemMap, restMap.value);
        }
      }
      items.push(itemMap);
      continue;
    }

    const parsed = parseInlineOrChildValue(cursor, afterDashTrimmed, expectedIndent, depth);
    if (!parsed.ok) return { ok: false };
    items.push(parsed.value);
  }

  return { ok: true, value: items };
}

function parseBlockMapping(
  cursor: LineCursor,
  expectedIndent: number,
  depth: number,
  initialSeenKeys?: Set<string>,
): { ok: true; value: Record<string, YamlValue> } | { ok: false } {
  if (depth > MAX_ORCA_YAML_DEPTH) return { ok: false };
  const map: Record<string, YamlValue> = {};
  const seen = initialSeenKeys ?? new Set<string>();

  while (cursor.index < cursor.lines.length) {
    if (!skipBlankLines(cursor)) return { ok: false };
    if (cursor.index >= cursor.lines.length) break;

    const line = cursor.lines[cursor.index] ?? "";
    if (hasLeadingTab(line)) return { ok: false };
    const indent = getIndent(line);
    const trimmed = stripYamlComment(line).trim();
    if (indent === 0 && (trimmed === "---" || trimmed === "...")) break;
    if (indent < expectedIndent) break;
    if (indent > expectedIndent) return { ok: false };
    if (isSequenceIndicator(trimmed)) return { ok: false };

    const split = splitMappingKeyValue(trimmed);
    if (!split) return { ok: false };

    const keyParsed = parseYamlScalar(split.keyRaw);
    if (!keyParsed.ok || typeof keyParsed.value !== "string") return { ok: false };
    const key = keyParsed.value;
    if (seen.has(key)) return { ok: false };
    seen.add(key);

    const valParsed = parseInlineOrChildValue(cursor, split.restRaw, indent, depth);
    if (!valParsed.ok) return { ok: false };
    map[key] = valParsed.value;
  }

  return { ok: true, value: map };
}

function isPlainObject(value: YamlValue): value is Record<string, YamlValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseOrcaYaml(raw: string): ParsedOrcaYaml | null {
  if (raw.includes("\0") || Buffer.byteLength(raw, "utf8") > MAX_ORCA_YAML_BYTES) {
    return null;
  }

  const cursor: LineCursor = {
    lines: raw.split(/\r?\n/),
    index: 0,
  };

  if (!skipBlankLines(cursor)) return null;
  if (cursor.index >= cursor.lines.length) return null;

  const firstLine = cursor.lines[cursor.index] ?? "";
  if (hasLeadingTab(firstLine)) return null;
  const firstTrimmed = stripYamlComment(firstLine).trim();
  if (getIndent(firstLine) === 0 && firstTrimmed === "---") {
    cursor.index++;
    if (!skipBlankLines(cursor)) return null;
    if (cursor.index >= cursor.lines.length) return null;
  }

  const docStartLine = cursor.lines[cursor.index] ?? "";
  if (hasLeadingTab(docStartLine)) return null;
  const docStartTrimmed = stripYamlComment(docStartLine).trim();
  const docStartIndent = getIndent(docStartLine);

  if (docStartTrimmed === "..." || docStartTrimmed === "---") return null;
  if (isSequenceIndicator(docStartTrimmed)) return null;

  let root: YamlValue;
  if (docStartTrimmed.startsWith("{")) {
    const flowText = collectFlowText(cursor, docStartTrimmed, 0);
    if (flowText === null) return null;
    const parsed = parseFlowValue(flowText, 1);
    if (!parsed.ok) return null;
    root = parsed.value;
  } else {
    if (docStartIndent !== 0) return null;
    const parsed = parseBlockMapping(cursor, 0, 1);
    if (!parsed.ok) return null;
    root = parsed.value;
  }

  if (!skipBlankLines(cursor)) return null;
  if (cursor.index < cursor.lines.length) {
    const trailingLine = cursor.lines[cursor.index] ?? "";
    const trailingTrimmed = stripYamlComment(trailingLine).trim();
    if (getIndent(trailingLine) === 0 && trailingTrimmed === "...") {
      cursor.index++;
      if (!skipBlankLines(cursor)) return null;
    }
    if (cursor.index < cursor.lines.length) {
      return null;
    }
  }

  if (!isPlainObject(root) || Object.keys(root).length === 0) {
    return null;
  }

  let setupCommand: string | null = null;
  let archiveCommand: string | null = null;
  if ("scripts" in root && root.scripts !== null) {
    if (!isPlainObject(root.scripts)) return null;
    const setupRaw = root.scripts.setup;
    if (setupRaw !== undefined) {
      if (typeof setupRaw !== "string") return null;
      setupCommand = setupRaw || null;
    }
    const archiveRaw = root.scripts.archive;
    if (archiveRaw !== undefined) {
      if (typeof archiveRaw !== "string") return null;
      archiveCommand = archiveRaw || null;
    }
  }

  const sharedDirectories: string[] = [];
  const rawDirs =
    "sharedDirectories" in root
      ? root.sharedDirectories
      : "shared_directories" in root
        ? root.shared_directories
        : undefined;
  if (rawDirs !== undefined && rawDirs !== null) {
    if (!Array.isArray(rawDirs)) return null;
    for (const item of rawDirs) {
      if (typeof item !== "string") return null;
      if (item) sharedDirectories.push(item);
    }
  }

  return {
    setupCommand,
    archiveCommand,
    sharedDirectories,
  };
}
