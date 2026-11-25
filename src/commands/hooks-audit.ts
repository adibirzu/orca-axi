/**
 * `hooks-audit`: strictly read-only audit of Orca worktree hooks and repo config.
 *
 * Calls `resolveOrca()` first to preserve the GNOME screen-reader guard and
 * `ORCA_CLI_COMMAND` semantics, queries `orca repo list --json` (and
 * optionally `~/.config/orca-axi/portfolio-catalog.json` with `--all`), and
 * inspects on-disk `orca.yaml` and `scripts/orca-worktree-*.sh` files using
 * symlink-safe / hardlink-safe / `O_NOFOLLOW` reads. Never mutates repo files
 * or Orca UI/DB settings and enforces one output-boundary redaction policy
 * across both JSON and TOON outputs so `.env` values, secrets, private IPs,
 * and personal home identifiers are never emitted.
 */

import { execFileSync } from "node:child_process";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

import { AxiError } from "axi-sdk-js";

import { parseArgs, type FlagSpec } from "../args.js";
import { resolveOrca, type OrcaResolution } from "../orca-resolve.js";
import { MAX_ORCA_YAML_BYTES, parseOrcaYaml, type ParsedOrcaYaml } from "../orca-yaml.js";
import {
  loadPortfolioCatalog,
  type CatalogLoadResult,
  type LoadCatalogOptions,
} from "../portfolio/catalog.js";
import { collapseHome, helpBlock, toon } from "../render.js";

export { parseOrcaYaml };

const MAX_AUDIT_FILE_BYTES = MAX_ORCA_YAML_BYTES;
const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;

const ALLOWED_COMMAND_SOURCE_POLICIES = new Set([
  "local-only",
  "repo-only",
  "prefer-repo",
  "prefer-local",
  "repo-first",
  "local-first",
  "orca-yaml",
  "merged",
  "auto",
  "default",
]);

const HOOKS_AUDIT_FLAGS: FlagSpec[] = [
  { name: "--repo", value: "path", description: "Audit a single repository path" },
  {
    name: "--all",
    description: "Audit both Orca-registered repos and portfolio-catalog.json repos",
  },
  { name: "--json", description: "Emit machine-readable JSON" },
];

export const HOOKS_AUDIT_HELP = `usage: orca-axi hooks-audit [--repo <path>] [--all] [--json]
description:
  Strictly read-only audit of Orca worktree hook configuration across
  registered Orca repos (and portfolio repos with --all, or one repo
  with --repo <path>). Resolves the Orca binary first (preserving the
  GNOME screen-reader guard), queries \`orca repo list --json\`, and
  safely inspects on-disk orca.yaml and scripts/orca-worktree-*.sh using
  O_NOFOLLOW and st_nlink == 1 reads without mutating repo files or Orca settings.
findings:
  missing_orca_yaml     checked-in orca.yaml is absent
  local_only_override   Orca commandSourcePolicy is local-only (bypasses orca.yaml)
  missing_archive_hook  archive hook missing in orca.yaml or script missing on disk
  unsafe_shared_dirs    sharedDirectories includes .venv, node_modules, .next, target, or caches
  missing_setup_script  orca.yaml references a setup script that does not exist on disk
  unsafe_symlink        hook file or scripts/ is a symlink, hardlink, special file, or escapes repo root
  invalid_orca_yaml     orca.yaml could not be parsed as a valid YAML mapping
  missing_repo_dir      registered/catalog repo directory does not exist on disk
  unreadable_hook       referenced or discovered hook script could not be read
  oversized_hook        hook script exceeds the 256 KiB inspection limit
outputs:
  status: ok | degraded | refused | error (exit 0 on ok/refused or --repo fallback; exit 1 on query/catalog failure; exit 2 on CLI usage error)
  TOON summary: status, scope, summary{}, repos[]
  --json  machine-readable {hooksAudit: ...} envelope
flags[${HOOKS_AUDIT_FLAGS.length + 1}]:
${HOOKS_AUDIT_FLAGS.map((f) => `  ${f.name}${f.value ? ` <${f.value}>` : ""}`).join(", ")}, --help
examples:
  orca-axi hooks-audit
  orca-axi hooks-audit --json
  orca-axi hooks-audit --all --json
  orca-axi hooks-audit --repo ~/dev/orca-axi
`;

export type HooksAuditScope = "registered" | "all" | "repo";
export type HooksAuditStatus = "ok" | "degraded" | "refused" | "error";

export type HooksAuditFindingCode =
  | "missing_orca_yaml"
  | "invalid_orca_yaml"
  | "local_only_override"
  | "missing_archive_hook"
  | "missing_setup_script"
  | "unsafe_shared_dirs"
  | "unsafe_symlink"
  | "missing_repo_dir"
  | "hardcoded_home_path"
  | "empty_hook_script"
  | "unreadable_hook"
  | "oversized_hook";

export interface HooksAuditFinding {
  readonly code: HooksAuditFindingCode;
  readonly severity: "error" | "warning";
  readonly file?: string;
  readonly message: string;
  readonly details?: Record<string, unknown>;
}

export type RepoSource = "orca" | "portfolio" | "explicit";

export interface AuditedRepoReport {
  readonly name: string;
  readonly path: string;
  readonly sources: readonly RepoSource[];
  readonly commandSourcePolicy: string | null;
  readonly orcaYamlPresent: boolean;
  readonly setupHookConfigured: boolean;
  readonly archiveHookConfigured: boolean;
  readonly status: "clean" | "drift";
  readonly findingCount: number;
  readonly findings: readonly HooksAuditFinding[];
}

export interface HooksAuditByCode {
  readonly missing_orca_yaml: number;
  readonly invalid_orca_yaml: number;
  readonly local_only_override: number;
  readonly missing_archive_hook: number;
  readonly missing_setup_script: number;
  readonly unsafe_shared_dirs: number;
  readonly unsafe_symlink: number;
  readonly missing_repo_dir: number;
  readonly hardcoded_home_path: number;
  readonly empty_hook_script: number;
  readonly unreadable_hook: number;
  readonly oversized_hook: number;
}

export interface HooksAuditSummary {
  readonly totalRepos: number;
  readonly cleanRepos: number;
  readonly driftRepos: number;
  readonly totalFindings: number;
  readonly errors: number;
  readonly warnings: number;
  readonly byCode: HooksAuditByCode;
}

export interface HooksAuditDeps {
  resolve?: () => OrcaResolution;
  runOrcaRepoList?: (orcaBin: string) => string;
  loadCatalog?: (options?: LoadCatalogOptions) => CatalogLoadResult;
  setExitCode?: (code: number) => void;
  cwd?: string;
  homeDir?: string;
}

interface OrcaRegisteredRepo {
  readonly displayName: string;
  readonly path: string;
  readonly commandSourcePolicy: string | null;
  readonly hasLocalSetupCommand: boolean;
  readonly hasLocalArchiveCommand: boolean;
}

interface AuditTarget {
  readonly name: string;
  readonly fsPath: string;
  readonly sources: Set<RepoSource>;
  readonly orcaMeta?: OrcaRegisteredRepo;
}

type SafeReadResult =
  | { readonly status: "ok"; readonly content: string }
  | { readonly status: "missing" }
  | { readonly status: "unsafe"; readonly reason: string }
  | { readonly status: "error"; readonly reason: string };

const ALL_FINDING_CODES: readonly HooksAuditFindingCode[] = [
  "missing_orca_yaml",
  "invalid_orca_yaml",
  "local_only_override",
  "missing_archive_hook",
  "missing_setup_script",
  "unsafe_shared_dirs",
  "unsafe_symlink",
  "missing_repo_dir",
  "hardcoded_home_path",
  "empty_hook_script",
  "unreadable_hook",
  "oversized_hook",
];

const UNSAFE_SHARED_DIR_NAMES = new Set([
  ".venv",
  "venv",
  ".virtualenv",
  "virtualenv",
  "node_modules",
  ".pnpm-store",
  ".next",
  ".nuxt",
  ".turbo",
  "target",
  "dist",
  "build",
  "__pycache__",
  ".pytest_cache",
  ".ruff_cache",
  ".mypy_cache",
  ".cache",
  "caches",
  ".gradle",
  ".cargo",
  ".terraform",
  ".parcel-cache",
  ".svelte-kit",
  ".vite",
  ".env",
]);

function defaultRunOrcaRepoList(orcaBin: string): string {
  return execFileSync(orcaBin, ["repo", "list", "--json"], {
    encoding: "utf8",
    timeout: 10000,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function normalizePathKey(rawPath: string): string {
  const resolved = resolve(rawPath).replace(/\/+$/, "");
  try {
    return realpathSync(resolved).replace(/\/+$/, "");
  } catch {
    return resolved;
  }
}

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function redactPath(rawPath: string, effectiveHome: string): string {
  const collapsed = collapseHome(rawPath, effectiveHome);
  return collapsed.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, "~");
}

function stripControlChars(raw: string): string {
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i] ?? "";
    const code = ch.charCodeAt(0);
    if (code === 0x0d) {
      if (raw.charCodeAt(i + 1) === 0x0a) i++;
      out += " ";
    } else if (code === 0x0a) {
      out += " ";
    } else if ((code >= 0x20 && code !== 0x7f) || code === 0x09) {
      out += ch;
    }
  }
  return out;
}

/**
 * Single uniform output-boundary redactor applied to all externally sourced
 * strings across both JSON and TOON outputs (idempotent across repeated calls).
 */
function redactOutputText(raw: string, effectiveHome: string): string {
  let out = stripControlChars(raw);

  if (effectiveHome && effectiveHome !== "/") {
    const homePattern = new RegExp(
      `(^|[\\s"'=:(])${escapeRegExp(effectiveHome)}(?=$|[\\s/"':;,)])`,
      "g",
    );
    out = out.replace(homePattern, "$1~");
  }

  return out
    .replace(/\/(?:Users|home)\/[^/\s"';:)]+/g, "~")
    .replace(/(https?:\/\/)[^/\s@]+@/gi, "$1<redacted>@")
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, "<redacted-ip>")
    .replace(/[A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)/g, "<redacted-kv>")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1<redacted-secret>")
    .replace(/((?:--?(?:api[-_]?key|token|secret|password|passwd|auth))[=\s]+)\S+/gi, "$1<redacted-secret>")
    .replace(
      /\b(?:sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{8,}|gho_[A-Za-z0-9]{8,}|ghu_[A-Za-z0-9]{8,}|ghs_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,}|xox[baprs]-[A-Za-z0-9-]{8,}|pcp_[A-Za-z0-9_-]{8,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{20,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]+)?)\b/g,
      "<redacted-secret>",
    )
    .replace(
      /(?<!<)\b(?!(?:redacted-(?:ip|kv|secret|policy|version))\b)[A-Za-z0-9_-]*(?:secret|token|password|passwd|api[-_]?key|credential)[A-Za-z0-9_-]*\b(?!>)/gi,
      "<redacted-secret>",
    );
}

function sanitizeCommandSourcePolicy(raw: string | null): string | null {
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return ALLOWED_COMMAND_SOURCE_POLICIES.has(trimmed) ? trimmed : "<redacted-policy>";
}

function extractSafeVersionToken(rawVersion: string, effectiveHome: string): string {
  const redacted = redactOutputText(rawVersion, effectiveHome).trim();
  if (redacted === "unprobed") return "unprobed";
  const match = /(?:^|\s)(v?\d+\.\d+(?:\.\d+)?)(?=$|\s)/.exec(redacted);
  return match?.[1] ?? "<redacted-version>";
}

function sanitizeRefusalReason(reason: string | undefined, effectiveHome: string): string {
  if (!reason) {
    return "Refused to invoke candidate binary as the Orca runtime.";
  }
  const strippedVersion = reason.replace(
    /(\bGNOME screen reader\s*\()([^)]+)(\))|(\bResolved\s+\S+\s*\()([^)]+)(\)\s+is the GNOME screen reader)/gi,
    (
      _full,
      p1?: string,
      v1?: string,
      p3?: string,
      p4?: string,
      v2?: string,
      p6?: string,
    ) => {
      if (p1 && v1 !== undefined && p3) {
        return `${p1}${extractSafeVersionToken(v1, effectiveHome)}${p3}`;
      }
      if (p4 && v2 !== undefined && p6) {
        return `${p4}${extractSafeVersionToken(v2, effectiveHome)}${p6}`;
      }
      return _full;
    },
  );
  return redactOutputText(strippedVersion, effectiveHome);
}

const DANGEROUS_OBJECT_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function ownProp(obj: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(obj, key) ? obj[key] : undefined;
}

function sanitizePayloadValue<T>(value: T, effectiveHome: string): T {
  if (typeof value === "string") {
    return redactOutputText(value, effectiveHome) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizePayloadValue(item, effectiveHome)) as unknown as T;
  }
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined || DANGEROUS_OBJECT_KEYS.has(k)) continue;
      if (k === "commandSourcePolicy" && typeof v === "string") {
        out[k] = sanitizeCommandSourcePolicy(v);
      } else {
        out[k] = sanitizePayloadValue(v, effectiveHome);
      }
    }
    return out as T;
  }
  return value;
}

function isEnvPath(relPath: string): boolean {
  const base = basename(relPath).toLowerCase();
  return base === ".env" || base.startsWith(".env.");
}

function safeReadRepoFile(repoRoot: string, relPath: string): SafeReadResult {
  if (!relPath || relPath.includes("\0") || isAbsolute(relPath)) {
    return { status: "unsafe", reason: "absolute_or_invalid_path" };
  }
  const normalizedRel = relPath.replace(/\\/g, "/");
  const segments = normalizedRel.split("/").filter((s) => s.length > 0 && s !== ".");
  if (segments.length === 0 || segments.some((s) => s === "..")) {
    return { status: "unsafe", reason: "path_traversal" };
  }
  if (isEnvPath(segments[segments.length - 1] ?? "")) {
    return { status: "unsafe", reason: "sensitive_env_file" };
  }

  const candidate = resolve(repoRoot, ...segments);
  const relCheck = relative(repoRoot, candidate);
  if (!relCheck || relCheck.startsWith("..") || isAbsolute(relCheck)) {
    return { status: "unsafe", reason: "escapes_repo_root" };
  }

  let current = repoRoot;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (!seg) continue;
    current = join(current, seg);
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(current);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code === "ENOENT" || code === "ENOTDIR") {
        return { status: "missing" };
      }
      return { status: "error", reason: code ?? "stat_failed" };
    }

    if (stat.isSymbolicLink()) {
      return { status: "unsafe", reason: "symlink" };
    }
    const isLast = i === segments.length - 1;
    if (!isLast && !stat.isDirectory()) {
      return { status: "unsafe", reason: "not_directory" };
    }
    if (isLast && !stat.isFile()) {
      return { status: "unsafe", reason: "special_file" };
    }
  }

  let fd: number;
  try {
    fd = openSync(candidate, fsConstants.O_RDONLY | O_NOFOLLOW);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ELOOP") {
      return { status: "unsafe", reason: "symlink" };
    }
    if (code === "ENOENT") {
      return { status: "missing" };
    }
    return { status: "error", reason: code ?? "open_failed" };
  }

  try {
    const st = fstatSync(fd);
    if (!st.isFile()) {
      return { status: "unsafe", reason: "special_file" };
    }
    if (st.nlink !== 1) {
      return { status: "unsafe", reason: "hardlink" };
    }
    if (st.size > MAX_AUDIT_FILE_BYTES) {
      return { status: "error", reason: "file_too_large" };
    }
    const chunks: Buffer[] = [];
    const buf = Buffer.allocUnsafe(8192);
    let total = 0;
    while (total <= MAX_AUDIT_FILE_BYTES) {
      const bytesRead = readSync(fd, buf, 0, buf.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > MAX_AUDIT_FILE_BYTES) {
        return { status: "error", reason: "file_too_large" };
      }
      chunks.push(Buffer.from(buf.subarray(0, bytesRead)));
    }
    return { status: "ok", content: Buffer.concat(chunks).toString("utf8") };
  } finally {
    closeSync(fd);
  }
}

function listOrcaWorktreeScripts(repoRoot: string): {
  readonly status: "ok" | "missing" | "unsafe" | "error";
  readonly files: readonly string[];
  readonly reason?: string;
} {
  const scriptsDir = join(repoRoot, "scripts");
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(scriptsDir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") return { status: "missing", files: [] };
    return { status: "error", files: [], reason: code ?? "stat_failed" };
  }
  if (st.isSymbolicLink() || !st.isDirectory()) {
    return { status: "unsafe", files: [] };
  }
  try {
    const entries = readdirSync(scriptsDir)
      .filter((name) => /^orca-worktree-.*\.sh$/.test(name))
      .sort();
    return { status: "ok", files: entries.map((name) => `scripts/${name}`) };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    return { status: "error", files: [], reason: code ?? "readdir_failed" };
  }
}

function extractReferencedScripts(command: string | null): string[] {
  if (!command) return [];
  const results = new Set<string>();
  const tokens = command
    .replace(/[;|&()[\]{}]/g, " ")
    .split(/\s+/)
    .map((t) => t.replace(/^["']+|["']+$/g, ""))
    .filter(Boolean);

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i] ?? "";
    const prev = i > 0 ? tokens[i - 1] : undefined;
    if (
      tok.startsWith("-") ||
      tok.includes("://") ||
      tok === "/dev/null" ||
      /[*?]/.test(tok)
    ) {
      continue;
    }
    if (tok.includes("=") && !tok.startsWith("./") && !tok.startsWith("../")) {
      continue;
    }
    const isShellTarget =
      prev === "bash" ||
      prev === "sh" ||
      prev === "zsh" ||
      prev === "source" ||
      prev === "." ||
      prev === "-f" ||
      prev === "-x" ||
      prev === "-e";
    if (tok.endsWith(".sh") || (isShellTarget && (tok.includes("/") || tok.includes("..")))) {
      results.add(tok.startsWith("./") ? tok.slice(2) : tok);
    }
  }
  return [...results];
}

function isUnsafeSharedDirEntry(entry: string): boolean {
  const cleaned = entry.trim().replace(/^\.\//, "").replace(/\/+$/, "");
  if (!cleaned || cleaned === "." || cleaned.startsWith("/") || cleaned.startsWith("~")) {
    return true;
  }
  const segments = cleaned.split("/").filter(Boolean);
  if (segments.some((s) => s === "..")) {
    return true;
  }
  for (const seg of segments) {
    const lower = seg.toLowerCase();
    if (UNSAFE_SHARED_DIR_NAMES.has(lower)) {
      return true;
    }
    if (
      lower === "cache" ||
      lower.endsWith(".cache") ||
      lower.endsWith("_cache") ||
      lower.endsWith("-cache")
    ) {
      return true;
    }
  }
  return false;
}

function hasHardcodedHomePath(content: string): boolean {
  return /(?:^|[\s"'=:])\/(?:Users|home)\/[A-Za-z0-9._-]+(?=\/|$|[\s"';:])/.test(content);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractEnvelopeError(parsed: Record<string, unknown>): string {
  const err = ownProp(parsed, "error");
  if (typeof err === "string" && err.trim()) return err.trim();
  if (isRecord(err)) {
    const msg = ownProp(err, "message");
    if (typeof msg === "string" && msg.trim()) {
      return msg.trim();
    }
  }
  return "Orca CLI returned an error envelope";
}

function parseOrcaRepoList(raw: string): OrcaRegisteredRepo[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new AxiError("`orca repo list --json` did not emit valid JSON", "RUNTIME_ERROR", [
      "Run `orca repo list --json` directly to verify the Orca CLI output",
    ]);
  }
  if (!isRecord(parsed)) {
    throw new AxiError("`orca repo list --json` returned an unexpected response shape", "RUNTIME_ERROR", [
      "Run `orca repo list --json` directly to verify the Orca CLI output",
    ]);
  }
  const okVal = ownProp(parsed, "ok");
  if (okVal === false) {
    throw new AxiError(
      `\`orca repo list --json\` failed: ${extractEnvelopeError(parsed)}`,
      "RUNTIME_ERROR",
      ["Ensure the Orca runtime daemon is running and `orca repo list --json` succeeds"],
    );
  }
  const resultVal = ownProp(parsed, "result");
  const reposVal = isRecord(resultVal) ? ownProp(resultVal, "repos") : undefined;
  if (okVal !== true || !Array.isArray(reposVal)) {
    throw new AxiError("`orca repo list --json` returned an unexpected response shape", "RUNTIME_ERROR", [
      "Run `orca repo list --json` directly to verify the Orca CLI output",
    ]);
  }

  const out: OrcaRegisteredRepo[] = [];
  for (const item of reposVal) {
    if (!isRecord(item)) continue;
    const rawItemPath = ownProp(item, "path");
    const path = typeof rawItemPath === "string" ? rawItemPath.trim() : "";
    if (!path) continue;
    const rawDisplayName = ownProp(item, "displayName");
    const displayName =
      typeof rawDisplayName === "string" && rawDisplayName.trim()
        ? rawDisplayName.trim()
        : basename(path);
    const rawHookSettings = ownProp(item, "hookSettings");
    const hookSettings = isRecord(rawHookSettings) ? rawHookSettings : null;
    const rawCommandSourcePolicy = hookSettings ? ownProp(hookSettings, "commandSourcePolicy") : undefined;
    const rawPolicy =
      typeof rawCommandSourcePolicy === "string"
        ? rawCommandSourcePolicy.trim()
        : null;
    const commandSourcePolicy = sanitizeCommandSourcePolicy(rawPolicy);
    const rawScripts = hookSettings ? ownProp(hookSettings, "scripts") : undefined;
    const scripts = isRecord(rawScripts) ? rawScripts : null;
    const rawSetup = scripts ? ownProp(scripts, "setup") : undefined;
    const rawArchive = scripts ? ownProp(scripts, "archive") : undefined;
    const setupCmd = typeof rawSetup === "string" ? rawSetup.trim() : "";
    const archiveCmd = typeof rawArchive === "string" ? rawArchive.trim() : "";

    out.push({
      displayName,
      path,
      commandSourcePolicy,
      hasLocalSetupCommand: setupCmd.length > 0,
      hasLocalArchiveCommand: archiveCmd.length > 0,
    });
  }
  return out;
}

function createByCodeCounter(): Map<HooksAuditFindingCode, number> {
  const counts = new Map<HooksAuditFindingCode, number>();
  for (const code of ALL_FINDING_CODES) {
    counts.set(code, 0);
  }
  return counts;
}

function toByCodeRecord(counts: ReadonlyMap<HooksAuditFindingCode, number>): HooksAuditByCode {
  return {
    missing_orca_yaml: counts.get("missing_orca_yaml") ?? 0,
    invalid_orca_yaml: counts.get("invalid_orca_yaml") ?? 0,
    local_only_override: counts.get("local_only_override") ?? 0,
    missing_archive_hook: counts.get("missing_archive_hook") ?? 0,
    missing_setup_script: counts.get("missing_setup_script") ?? 0,
    unsafe_shared_dirs: counts.get("unsafe_shared_dirs") ?? 0,
    unsafe_symlink: counts.get("unsafe_symlink") ?? 0,
    missing_repo_dir: counts.get("missing_repo_dir") ?? 0,
    hardcoded_home_path: counts.get("hardcoded_home_path") ?? 0,
    empty_hook_script: counts.get("empty_hook_script") ?? 0,
    unreadable_hook: counts.get("unreadable_hook") ?? 0,
    oversized_hook: counts.get("oversized_hook") ?? 0,
  };
}

function emptySummary(): HooksAuditSummary {
  return {
    totalRepos: 0,
    cleanRepos: 0,
    driftRepos: 0,
    totalFindings: 0,
    errors: 0,
    warnings: 0,
    byCode: toByCodeRecord(createByCodeCounter()),
  };
}

function pushScriptFailureFinding(
  findings: HooksAuditFinding[],
  relPath: string,
  roleLabel: "setup" | "archive" | "discovered",
  result: Extract<SafeReadResult, { readonly status: "unsafe" | "error" }>,
  effectiveHome: string,
): void {
  const safeFile = redactOutputText(relPath, effectiveHome);
  const safeReason = redactOutputText(result.reason, effectiveHome);
  if (result.status === "unsafe") {
    const subject =
      roleLabel === "setup"
        ? "unsafe setup script path"
        : roleLabel === "archive"
          ? "unsafe archive script path"
          : "unsafe hook script";
    findings.push({
      code: "unsafe_symlink",
      severity: "error",
      file: safeFile,
      message: `Refused ${subject} (${safeReason})`,
    });
    return;
  }

  if (result.reason === "file_too_large") {
    findings.push({
      code: "oversized_hook",
      severity: "error",
      file: safeFile,
      message: `Hook script ${safeFile} exceeds ${MAX_AUDIT_FILE_BYTES} bytes (${safeReason})`,
    });
    return;
  }

  findings.push({
    code: "unreadable_hook",
    severity: "error",
    file: safeFile,
    message: `Unable to read hook script ${safeFile} (${safeReason})`,
  });
}

function auditTargetRepo(target: AuditTarget, effectiveHome: string): AuditedRepoReport {
  const findings: HooksAuditFinding[] = [];
  const redactedPath = redactOutputText(redactPath(target.fsPath, effectiveHome), effectiveHome);
  const policy = sanitizeCommandSourcePolicy(target.orcaMeta?.commandSourcePolicy ?? null);

  if (policy === "local-only") {
    findings.push({
      code: "local_only_override",
      severity: "warning",
      message: "Orca hookSettings.commandSourcePolicy is set to local-only, bypassing checked-in orca.yaml",
      details: {
        policy: "local-only",
        hasLocalSetupCommand: target.orcaMeta?.hasLocalSetupCommand ?? false,
        hasLocalArchiveCommand: target.orcaMeta?.hasLocalArchiveCommand ?? false,
      },
    });
  }

  let repoStat: ReturnType<typeof lstatSync> | null;
  try {
    repoStat = lstatSync(target.fsPath);
  } catch {
    repoStat = null;
  }

  if (!repoStat) {
    findings.push({
      code: "missing_repo_dir",
      severity: "error",
      message: "Repository directory does not exist on disk",
    });
    return buildRepoReport(target, redactedPath, policy, false, false, false, findings, effectiveHome);
  }

  if (repoStat.isSymbolicLink() || !repoStat.isDirectory()) {
    findings.push({
      code: "unsafe_symlink",
      severity: "error",
      message: "Repository root is a symlink or non-directory; refusing to inspect contents",
    });
    return buildRepoReport(target, redactedPath, policy, false, false, false, findings, effectiveHome);
  }

  const yamlRead = safeReadRepoFile(target.fsPath, "orca.yaml");
  let orcaYamlPresent = false;
  let parsedYaml: ParsedOrcaYaml | null = null;

  if (yamlRead.status === "missing") {
    findings.push({
      code: "missing_orca_yaml",
      severity: "warning",
      file: "orca.yaml",
      message: "Checked-in orca.yaml is missing",
    });
  } else if (yamlRead.status === "unsafe") {
    findings.push({
      code: "unsafe_symlink",
      severity: "error",
      file: "orca.yaml",
      message: `Refused to read orca.yaml (${redactOutputText(yamlRead.reason, effectiveHome)})`,
    });
  } else if (yamlRead.status === "error") {
    findings.push({
      code: "invalid_orca_yaml",
      severity: "error",
      file: "orca.yaml",
      message: `Unable to read orca.yaml (${redactOutputText(yamlRead.reason, effectiveHome)})`,
    });
  } else {
    orcaYamlPresent = true;
    parsedYaml = parseOrcaYaml(yamlRead.content);
    if (!parsedYaml) {
      findings.push({
        code: "invalid_orca_yaml",
        severity: "error",
        file: "orca.yaml",
        message: "orca.yaml could not be parsed as a valid YAML mapping",
      });
    } else if (hasHardcodedHomePath(yamlRead.content)) {
      findings.push({
        code: "hardcoded_home_path",
        severity: "warning",
        file: "orca.yaml",
        message: "orca.yaml references a hardcoded user home directory path",
      });
    }
  }

  if (parsedYaml && parsedYaml.sharedDirectories.length > 0) {
    const unsafeDirs = parsedYaml.sharedDirectories
      .filter(isUnsafeSharedDirEntry)
      .map((d) => redactOutputText(d, effectiveHome));
    if (unsafeDirs.length > 0) {
      findings.push({
        code: "unsafe_shared_dirs",
        severity: "error",
        file: "orca.yaml",
        message: "orca.yaml sharedDirectories includes non-shareable dependency, build, or cache paths",
        details: { unsafeDirs },
      });
    }
  }

  const scriptsListing = listOrcaWorktreeScripts(target.fsPath);
  if (scriptsListing.status === "unsafe") {
    findings.push({
      code: "unsafe_symlink",
      severity: "error",
      file: "scripts",
      message: "scripts/ is a symlink or non-directory; refusing to traverse",
    });
  } else if (scriptsListing.status === "error") {
    findings.push({
      code: "unreadable_hook",
      severity: "error",
      file: "scripts",
      message: `Unable to list scripts/ directory (${redactOutputText(scriptsListing.reason ?? "error", effectiveHome)})`,
    });
  }

  const inspectedScripts = new Set<string>();
  const scriptReadCache = new Map<string, SafeReadResult>();
  const inspectScript = (relPath: string): SafeReadResult => {
    const cached = scriptReadCache.get(relPath);
    if (cached) return cached;
    const res = safeReadRepoFile(target.fsPath, relPath);
    scriptReadCache.set(relPath, res);
    inspectedScripts.add(relPath);
    return res;
  };

  for (const scriptPath of scriptsListing.files) {
    inspectScript(scriptPath);
  }

  const setupRefs = extractReferencedScripts(parsedYaml?.setupCommand ?? null);
  const archiveRefs = extractReferencedScripts(parsedYaml?.archiveCommand ?? null);

  let setupHookConfigured = Boolean(
    parsedYaml?.setupCommand || target.orcaMeta?.hasLocalSetupCommand,
  );
  let archiveHookConfigured = Boolean(
    parsedYaml?.archiveCommand || target.orcaMeta?.hasLocalArchiveCommand,
  );

  for (const ref of setupRefs) {
    const safeRef = redactOutputText(ref, effectiveHome);
    const res = inspectScript(ref);
    if (res.status === "missing") {
      findings.push({
        code: "missing_setup_script",
        severity: "warning",
        file: safeRef,
        message: `Referenced setup script ${safeRef} does not exist on disk`,
      });
      setupHookConfigured = false;
    } else if (res.status === "unsafe" || res.status === "error") {
      pushScriptFailureFinding(findings, ref, "setup", res, effectiveHome);
      setupHookConfigured = false;
    }
  }

  let archiveMissingEmitted = false;
  if (parsedYaml && !parsedYaml.archiveCommand) {
    findings.push({
      code: "missing_archive_hook",
      severity: "warning",
      file: "orca.yaml",
      message: "orca.yaml does not define scripts.archive",
    });
    archiveMissingEmitted = true;
    archiveHookConfigured = false;
  } else {
    for (const ref of archiveRefs) {
      const safeRef = redactOutputText(ref, effectiveHome);
      const res = inspectScript(ref);
      if (res.status === "missing") {
        findings.push({
          code: "missing_archive_hook",
          severity: "warning",
          file: safeRef,
          message: `Referenced archive hook script ${safeRef} does not exist on disk`,
        });
        archiveMissingEmitted = true;
        archiveHookConfigured = false;
      } else if (res.status === "unsafe" || res.status === "error") {
        pushScriptFailureFinding(findings, ref, "archive", res, effectiveHome);
        archiveHookConfigured = false;
      }
    }
  }

  const setupScriptRes = scriptReadCache.get("scripts/orca-worktree-setup.sh");
  const archiveScriptRes = scriptReadCache.get("scripts/orca-worktree-archive.sh");
  const setupScriptOnDisk = setupScriptRes?.status === "ok";
  const archiveScriptOnDisk = archiveScriptRes?.status === "ok";

  if (
    !orcaYamlPresent &&
    !archiveMissingEmitted &&
    (setupScriptOnDisk || target.orcaMeta?.hasLocalSetupCommand) &&
    !archiveScriptOnDisk &&
    !target.orcaMeta?.hasLocalArchiveCommand
  ) {
    findings.push({
      code: "missing_archive_hook",
      severity: "warning",
      file: "scripts/orca-worktree-archive.sh",
      message: "Setup hook is configured without an archive cleanup hook",
    });
  }

  for (const scriptPath of inspectedScripts) {
    const res = scriptReadCache.get(scriptPath);
    if (!res) continue;
    const alreadyHandledAsRef = setupRefs.includes(scriptPath) || archiveRefs.includes(scriptPath);
    if (res.status === "unsafe" || res.status === "error") {
      if (!alreadyHandledAsRef) {
        pushScriptFailureFinding(findings, scriptPath, "discovered", res, effectiveHome);
      }
      if (scriptPath === "scripts/orca-worktree-setup.sh") {
        setupHookConfigured = false;
      } else if (scriptPath === "scripts/orca-worktree-archive.sh") {
        archiveHookConfigured = false;
      }
    } else if (res.status === "ok") {
      const safeScriptPath = redactOutputText(scriptPath, effectiveHome);
      if (res.content.trim().length === 0) {
        findings.push({
          code: "empty_hook_script",
          severity: "warning",
          file: safeScriptPath,
          message: `Hook script ${safeScriptPath} is empty`,
        });
      } else if (hasHardcodedHomePath(res.content)) {
        findings.push({
          code: "hardcoded_home_path",
          severity: "warning",
          file: safeScriptPath,
          message: `Hook script ${safeScriptPath} references a hardcoded user home directory path`,
        });
      }
    }
  }

  return buildRepoReport(
    target,
    redactedPath,
    policy,
    orcaYamlPresent,
    setupHookConfigured,
    archiveHookConfigured,
    findings,
    effectiveHome,
  );
}

function buildRepoReport(
  target: AuditTarget,
  redactedPath: string,
  commandSourcePolicy: string | null,
  orcaYamlPresent: boolean,
  setupHookConfigured: boolean,
  archiveHookConfigured: boolean,
  findings: readonly HooksAuditFinding[],
  effectiveHome: string,
): AuditedRepoReport {
  const sourceOrder: RepoSource[] = ["orca", "portfolio", "explicit"];
  const sources = sourceOrder.filter((s) => target.sources.has(s));
  return {
    name: redactOutputText(target.name, effectiveHome),
    path: redactedPath,
    sources,
    commandSourcePolicy: sanitizeCommandSourcePolicy(commandSourcePolicy),
    orcaYamlPresent,
    setupHookConfigured,
    archiveHookConfigured,
    status: findings.length === 0 ? "clean" : "drift",
    findingCount: findings.length,
    findings,
  };
}

function summarizeReports(reports: readonly AuditedRepoReport[]): HooksAuditSummary {
  const byCode = createByCodeCounter();
  let cleanRepos = 0;
  let driftRepos = 0;
  let totalFindings = 0;
  let errors = 0;
  let warnings = 0;

  for (const repo of reports) {
    if (repo.status === "clean") cleanRepos++;
    else driftRepos++;
    for (const finding of repo.findings) {
      totalFindings++;
      if (finding.severity === "error") errors++;
      else warnings++;
      byCode.set(finding.code, (byCode.get(finding.code) ?? 0) + 1);
    }
  }

  return {
    totalRepos: reports.length,
    cleanRepos,
    driftRepos,
    totalFindings,
    errors,
    warnings,
    byCode: toByCodeRecord(byCode),
  };
}

function renderHooksAuditOutput(
  payload: Record<string, unknown>,
  json: boolean,
  toonHelpLines: readonly string[],
  effectiveHome: string,
): string {
  const sanitizedPayload = sanitizePayloadValue(payload, effectiveHome);
  if (json) {
    return JSON.stringify({ hooksAudit: sanitizedPayload }, null, 2);
  }

  const sanitizedHelp = toonHelpLines.map((line) => redactOutputText(line, effectiveHome));
  const payloadRepos = ownProp(sanitizedPayload, "repos");
  const payloadStatus = ownProp(sanitizedPayload, "status");
  const payloadReason = ownProp(sanitizedPayload, "reason");
  if (
    Array.isArray(payloadRepos) &&
    !(payloadReason !== undefined && (payloadStatus === "refused" || payloadStatus === "error"))
  ) {
    const reports = payloadRepos as AuditedRepoReport[];
    const summary = ownProp(sanitizedPayload, "summary") as HooksAuditSummary;
    const activeCodeCounts = Object.fromEntries(
      Object.entries(summary.byCode).filter(([code, count]) => !DANGEROUS_OBJECT_KEYS.has(code) && count > 0),
    );
    const payloadOrcaReason = ownProp(sanitizedPayload, "orcaReason");
    const payloadCatalogReason = ownProp(sanitizedPayload, "catalogReason");
    const compactView = {
      hooksAudit: {
        status: payloadStatus,
        platform: ownProp(sanitizedPayload, "platform"),
        scope: ownProp(sanitizedPayload, "scope"),
        ...(typeof payloadReason === "string" ? { reason: payloadReason } : {}),
        ...(typeof payloadOrcaReason === "string" ? { orcaReason: payloadOrcaReason } : {}),
        ...(typeof payloadCatalogReason === "string" ? { catalogReason: payloadCatalogReason } : {}),
        summary: {
          totalRepos: summary.totalRepos,
          cleanRepos: summary.cleanRepos,
          driftRepos: summary.driftRepos,
          totalFindings: summary.totalFindings,
          errors: summary.errors,
          warnings: summary.warnings,
          ...activeCodeCounts,
        },
        repos: reports.map((r) => ({
          name: r.name,
          status: r.status,
          policy: r.commandSourcePolicy ?? "-",
          findings: r.findings.map((f) => f.code).join(",") || "-",
          path: r.path,
        })),
      },
    };
    return toon(compactView, helpBlock(sanitizedHelp));
  }

  return toon({ hooksAudit: sanitizedPayload }, helpBlock(sanitizedHelp));
}

export async function hooksAuditCommand(
  args: string[],
  deps: HooksAuditDeps = {},
): Promise<string> {
  if (args.includes("--help") || args.includes("-h")) {
    return HOOKS_AUDIT_HELP;
  }

  const { booleans, values } = parseArgs("hooks-audit", args, HOOKS_AUDIT_FLAGS);
  const rawRepo = values.get("--repo");
  const all = booleans.has("--all");
  const json = booleans.has("--json");

  if (rawRepo !== undefined && all) {
    throw new AxiError("cannot combine --repo and --all", "VALIDATION_ERROR", [
      "Use --repo <path> to audit one repository or --all for registered + portfolio repositories",
    ]);
  }

  const scope: HooksAuditScope = rawRepo !== undefined ? "repo" : all ? "all" : "registered";
  const effectiveHome = deps.homeDir ?? process.env.ORCA_AXI_HOME?.trim() ?? homedir();
  const cwd = deps.cwd ?? process.cwd();
  const setExitCode = deps.setExitCode ?? ((code: number) => {
    process.exitCode = code;
  });

  const resolution = (deps.resolve ?? resolveOrca)();
  if (resolution.status === "refused") {
    return renderHooksAuditOutput(
      {
        status: "refused",
        platform: resolution.platform,
        scope,
        reason: sanitizeRefusalReason(resolution.reason, effectiveHome),
        suggestions: resolution.suggestions,
        summary: emptySummary(),
        repos: [],
      },
      json,
      resolution.suggestions,
      effectiveHome,
    );
  }

  let orcaRepos: OrcaRegisteredRepo[] = [];
  let orcaErrorReason: string | undefined =
    resolution.status !== "ok"
      ? resolution.reason ?? "No Orca terminal/session runtime binary was found."
      : undefined;

  if (resolution.status === "ok" && resolution.binary) {
    try {
      const rawList = (deps.runOrcaRepoList ?? defaultRunOrcaRepoList)(resolution.binary.path);
      orcaRepos = parseOrcaRepoList(rawList);
    } catch (err) {
      orcaErrorReason =
        err instanceof AxiError
          ? err.message
          : "Failed to query `orca repo list --json`";
    }
  }

  if (scope === "registered" && orcaErrorReason) {
    setExitCode(1);
    const suggestions =
      resolution.status === "ok"
        ? [
            "Ensure the Orca runtime daemon is running and `orca repo list --json` succeeds",
            "Or pass `--repo <path>` / `--all` to audit on-disk repositories",
          ]
        : resolution.suggestions;
    return renderHooksAuditOutput(
      {
        status: "error",
        platform: resolution.platform,
        scope,
        reason: orcaErrorReason,
        suggestions,
        summary: emptySummary(),
        repos: [],
      },
      json,
      suggestions,
      effectiveHome,
    );
  }

  const orcaByKey = new Map<string, OrcaRegisteredRepo>();
  for (const r of orcaRepos) {
    orcaByKey.set(normalizePathKey(r.path), r);
  }

  const targetsByKey = new Map<string, AuditTarget>();
  let catalogErrorReason: string | undefined;

  if (rawRepo !== undefined) {
    const absRepo = resolve(cwd, rawRepo);
    let st: ReturnType<typeof lstatSync> | null;
    try {
      st = lstatSync(absRepo);
    } catch {
      st = null;
    }
    if (!st || !st.isDirectory()) {
      throw new AxiError(`repository directory not found: ${redactPath(absRepo, effectiveHome)}`, "VALIDATION_ERROR", [
        "Pass an existing git repository directory to --repo <path>",
      ]);
    }
    const key = normalizePathKey(absRepo);
    const orcaMeta = orcaByKey.get(key);
    targetsByKey.set(key, {
      name: orcaMeta?.displayName ?? basename(absRepo),
      fsPath: absRepo,
      sources: new Set<RepoSource>(orcaMeta ? ["orca", "explicit"] : ["explicit"]),
      ...(orcaMeta ? { orcaMeta } : {}),
    });
  } else {
    for (const r of orcaRepos) {
      const key = normalizePathKey(r.path);
      if (!targetsByKey.has(key)) {
        targetsByKey.set(key, {
          name: r.displayName,
          fsPath: r.path,
          sources: new Set<RepoSource>(["orca"]),
          orcaMeta: r,
        });
      }
    }

    if (all) {
      const catalogResult = (deps.loadCatalog ?? loadPortfolioCatalog)({ homeDir: effectiveHome });
      if (catalogResult.status === "ok" && catalogResult.catalog) {
        for (const pr of catalogResult.catalog.repositories) {
          const key = normalizePathKey(pr.path);
          const existing = targetsByKey.get(key);
          if (existing) {
            existing.sources.add("portfolio");
          } else {
            targetsByKey.set(key, {
              name: pr.name,
              fsPath: pr.path,
              sources: new Set<RepoSource>(["portfolio"]),
            });
          }
        }
      } else {
        catalogErrorReason =
          catalogResult.error ??
          (catalogResult.status === "missing_catalog"
            ? "Portfolio catalog file is missing"
            : "Portfolio catalog file is invalid");
      }

      if (orcaErrorReason && catalogErrorReason) {
        setExitCode(1);
        const suggestions = [
          ...resolution.suggestions,
          "Run `orca-axi portfolio` to verify ~/.config/orca-axi/portfolio-catalog.json",
        ];
        return renderHooksAuditOutput(
          {
            status: "error",
            platform: resolution.platform,
            scope,
            reason: `${orcaErrorReason}; ${catalogErrorReason}`,
            orcaReason: orcaErrorReason,
            catalogReason: catalogErrorReason,
            suggestions,
            summary: emptySummary(),
            repos: [],
          },
          json,
          suggestions,
          effectiveHome,
        );
      }
    }
  }

  const orderedTargets = [...targetsByKey.values()].sort(
    (a, b) => a.name.localeCompare(b.name) || a.fsPath.localeCompare(b.fsPath),
  );
  const reports = orderedTargets.map((t) => auditTargetRepo(t, effectiveHome));
  const summary = summarizeReports(reports);

  let topStatus: HooksAuditStatus = "ok";
  let topReason: string | undefined;

  if (scope === "all" && (orcaErrorReason || catalogErrorReason)) {
    topStatus = "degraded";
    topReason = [orcaErrorReason, catalogErrorReason].filter(Boolean).join("; ");
    setExitCode(1);
  } else if (scope === "repo" && orcaErrorReason) {
    topStatus = "degraded";
    topReason = orcaErrorReason;
  }

  return renderHooksAuditOutput(
    {
      status: topStatus,
      platform: resolution.platform,
      scope,
      ...(topReason ? { reason: topReason } : {}),
      ...(orcaErrorReason ? { orcaReason: orcaErrorReason } : {}),
      ...(catalogErrorReason ? { catalogReason: catalogErrorReason } : {}),
      summary,
      repos: reports,
    },
    json,
    [
      "Run `orca-axi hooks-audit --json` for structured findings and per-file details",
      "Run `orca-axi hooks-audit --all` to include portfolio-catalog.json repositories",
    ],
    effectiveHome,
  );
}
