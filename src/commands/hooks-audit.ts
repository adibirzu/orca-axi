/**
 * `hooks-audit`: strictly read-only audit of Orca worktree hooks and repo config.
 *
 * Calls `resolveOrca()` first to preserve the GNOME screen-reader guard and
 * `ORCA_CLI_COMMAND` semantics, queries `orca repo list --json` (and
 * optionally `~/.config/orca-axi/portfolio-catalog.json` with `--all`), and
 * inspects on-disk `orca.yaml` and `scripts/orca-worktree-*.sh` files using
 * symlink-safe / `O_NOFOLLOW` reads. Never mutates repo files or Orca UI/DB
 * settings and never emits `.env` values, secrets, private IPs, or personal
 * home identifiers.
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
import {
  loadPortfolioCatalog,
  type CatalogLoadResult,
  type LoadCatalogOptions,
} from "../portfolio/catalog.js";
import { collapseHome, helpBlock, toon } from "../render.js";

const MAX_AUDIT_FILE_BYTES = 256 * 1024;
const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;

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
  O_NOFOLLOW reads without ever mutating repo files or Orca settings.
findings:
  missing_orca_yaml     checked-in orca.yaml is absent
  local_only_override   Orca commandSourcePolicy is local-only (bypasses orca.yaml)
  missing_archive_hook  archive hook missing in orca.yaml or script missing on disk
  unsafe_shared_dirs    sharedDirectories includes .venv, node_modules, .next, target, or caches
  missing_setup_script  orca.yaml references a setup script that does not exist on disk
  unsafe_symlink        hook file or scripts/ is a symlink, special file, or escapes repo root
  invalid_orca_yaml     orca.yaml could not be parsed as a valid YAML mapping
  missing_repo_dir      registered/catalog repo directory does not exist on disk
outputs:
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
  | "empty_hook_script";

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

interface ParsedOrcaYaml {
  readonly setupCommand: string | null;
  readonly archiveCommand: string | null;
  readonly sharedDirectories: readonly string[];
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

function redactPath(rawPath: string, effectiveHome: string): string {
  const collapsed = collapseHome(rawPath, effectiveHome);
  return collapsed.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, "~");
}

function sanitizeSafeToken(token: string): string {
  return token
    .replace(/\/(?:Users|home)\/[^/\s]+/g, "~")
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, "<redacted-ip>")
    .replace(/[A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)/g, "<redacted-kv>");
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
  readonly status: "ok" | "missing" | "unsafe";
  readonly files: readonly string[];
} {
  const scriptsDir = join(repoRoot, "scripts");
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(scriptsDir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") return { status: "missing", files: [] };
    return { status: "unsafe", files: [] };
  }
  if (st.isSymbolicLink() || !st.isDirectory()) {
    return { status: "unsafe", files: [] };
  }
  try {
    const entries = readdirSync(scriptsDir)
      .filter((name) => /^orca-worktree-.*\.sh$/.test(name))
      .sort();
    return { status: "ok", files: entries.map((name) => `scripts/${name}`) };
  } catch {
    return { status: "missing", files: [] };
  }
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

function parseYamlScalar(raw: string): { ok: true; value: string } | { ok: false } {
  const trimmed = raw.trim();
  if (!trimmed || trimmed === "null" || trimmed === "~") {
    return { ok: true, value: "" };
  }
  if (trimmed.startsWith('"')) {
    if (trimmed.length < 2 || !trimmed.endsWith('"')) return { ok: false };
    try {
      return { ok: true, value: JSON.parse(trimmed) as string };
    } catch {
      return { ok: true, value: trimmed.slice(1, -1) };
    }
  }
  if (trimmed.startsWith("'")) {
    if (trimmed.length < 2 || !trimmed.endsWith("'")) return { ok: false };
    return { ok: true, value: trimmed.slice(1, -1).replace(/''/g, "'") };
  }
  return { ok: true, value: trimmed };
}

function parseInlineYamlArray(raw: string): string[] | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return null;
  const inner = trimmed.slice(1, -1).trim();
  if (!inner) return [];
  const items: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
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
    if (!inSingle && !inDouble && ch === ",") {
      const parsed = parseYamlScalar(current);
      if (!parsed.ok) return null;
      if (parsed.value) items.push(parsed.value);
      current = "";
      continue;
    }
    current += ch;
  }
  if (inSingle || inDouble) return null;
  const last = parseYamlScalar(current);
  if (!last.ok) return null;
  if (last.value) items.push(last.value);
  return items;
}

export function parseOrcaYaml(raw: string): ParsedOrcaYaml | null {
  const lines = raw.split(/\r?\n/);
  let setupCommand: string | null = null;
  let archiveCommand: string | null = null;
  const sharedDirectories: string[] = [];

  let activeSection: "scripts" | "sharedDirectories" | "other" | null = null;
  let sectionIndent = 0;
  let hasAnyKey = false;

  for (const rawLine of lines) {
    const withoutComment = stripYamlComment(rawLine);
    if (!withoutComment.trim()) continue;

    const indent = withoutComment.length - withoutComment.trimStart().length;
    const trimmed = withoutComment.trim();

    if (indent === 0) {
      activeSection = null;
      sectionIndent = 0;
      if (trimmed.startsWith("-")) {
        return null;
      }
      const colonIdx = trimmed.indexOf(":");
      if (colonIdx <= 0) {
        return null;
      }
      const key = trimmed.slice(0, colonIdx).trim();
      const rest = trimmed.slice(colonIdx + 1).trim();
      hasAnyKey = true;

      if (key === "scripts") {
        if (!rest) {
          activeSection = "scripts";
        } else if (rest !== "{}") {
          return null;
        }
      } else if (key === "sharedDirectories" || key === "shared_directories") {
        if (!rest) {
          activeSection = "sharedDirectories";
        } else {
          const arr = parseInlineYamlArray(rest);
          if (!arr) return null;
          sharedDirectories.push(...arr);
        }
      } else if (!rest) {
        activeSection = "other";
      } else {
        const scalar = parseYamlScalar(rest);
        if (!scalar.ok) return null;
      }
      continue;
    }

    if (!activeSection) {
      return null;
    }
    if (sectionIndent === 0) {
      sectionIndent = indent;
    }

    if (activeSection === "sharedDirectories") {
      if (trimmed.startsWith("-")) {
        const itemRaw = trimmed.slice(1).trim();
        const scalar = parseYamlScalar(itemRaw);
        if (!scalar.ok) return null;
        if (scalar.value) sharedDirectories.push(scalar.value);
      } else if (indent < sectionIndent) {
        return null;
      }
      continue;
    }

    if (activeSection === "scripts") {
      if (trimmed.startsWith("-")) {
        return null;
      }
      const colonIdx = trimmed.indexOf(":");
      if (colonIdx <= 0) {
        return null;
      }
      const subKey = trimmed.slice(0, colonIdx).trim();
      const rest = trimmed.slice(colonIdx + 1).trim();
      const scalar = parseYamlScalar(rest);
      if (!scalar.ok) return null;
      if (subKey === "setup") {
        setupCommand = scalar.value || null;
      } else if (subKey === "archive") {
        archiveCommand = scalar.value || null;
      }
    }
  }

  return hasAnyKey
    ? {
        setupCommand,
        archiveCommand,
        sharedDirectories,
      }
    : null;
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
    if (tok.startsWith("-") || tok.includes("://") || tok === "/dev/null") {
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

function parseOrcaRepoList(raw: string): OrcaRegisteredRepo[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new AxiError("`orca repo list --json` did not emit valid JSON", "VALIDATION_ERROR", [
      "Run `orca repo list --json` directly to verify the Orca CLI output",
    ]);
  }
  if (typeof parsed !== "object" || parsed === null) {
    return [];
  }
  const result = (parsed as { result?: unknown }).result;
  const rawRepos =
    typeof result === "object" && result !== null
      ? (result as { repos?: unknown }).repos
      : undefined;
  if (!Array.isArray(rawRepos)) {
    return [];
  }

  const out: OrcaRegisteredRepo[] = [];
  for (const item of rawRepos) {
    if (typeof item !== "object" || item === null) continue;
    const rec = item as Record<string, unknown>;
    const path = typeof rec.path === "string" ? rec.path.trim() : "";
    if (!path) continue;
    const displayName =
      typeof rec.displayName === "string" && rec.displayName.trim()
        ? rec.displayName.trim()
        : basename(path);
    const hookSettings =
      typeof rec.hookSettings === "object" && rec.hookSettings !== null
        ? (rec.hookSettings as Record<string, unknown>)
        : null;
    const commandSourcePolicy =
      hookSettings && typeof hookSettings.commandSourcePolicy === "string"
        ? hookSettings.commandSourcePolicy.trim()
        : null;
    const scripts =
      hookSettings && typeof hookSettings.scripts === "object" && hookSettings.scripts !== null
        ? (hookSettings.scripts as Record<string, unknown>)
        : null;
    const setupCmd = scripts && typeof scripts.setup === "string" ? scripts.setup.trim() : "";
    const archiveCmd =
      scripts && typeof scripts.archive === "string" ? scripts.archive.trim() : "";

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

function auditTargetRepo(target: AuditTarget, effectiveHome: string): AuditedRepoReport {
  const findings: HooksAuditFinding[] = [];
  const redactedPath = redactPath(target.fsPath, effectiveHome);
  const policy = target.orcaMeta?.commandSourcePolicy ?? null;

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
    return buildRepoReport(target, redactedPath, policy, false, false, false, findings);
  }

  if (repoStat.isSymbolicLink() || !repoStat.isDirectory()) {
    findings.push({
      code: "unsafe_symlink",
      severity: "error",
      message: "Repository root is a symlink or non-directory; refusing to inspect contents",
    });
    return buildRepoReport(target, redactedPath, policy, false, false, false, findings);
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
      message: `Refused to read orca.yaml (${yamlRead.reason})`,
    });
  } else if (yamlRead.status === "error") {
    findings.push({
      code: "invalid_orca_yaml",
      severity: "error",
      file: "orca.yaml",
      message: `Unable to read orca.yaml (${yamlRead.reason})`,
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
      .map(sanitizeSafeToken);
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
    const res = inspectScript(ref);
    if (res.status === "missing") {
      findings.push({
        code: "missing_setup_script",
        severity: "warning",
        file: ref,
        message: `Referenced setup script ${sanitizeSafeToken(ref)} does not exist on disk`,
      });
      setupHookConfigured = false;
    } else if (res.status === "unsafe") {
      findings.push({
        code: "unsafe_symlink",
        severity: "error",
        file: sanitizeSafeToken(ref),
        message: `Refused unsafe setup script path (${res.reason})`,
      });
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
      const res = inspectScript(ref);
      if (res.status === "missing") {
        findings.push({
          code: "missing_archive_hook",
          severity: "warning",
          file: ref,
          message: `Referenced archive hook script ${sanitizeSafeToken(ref)} does not exist on disk`,
        });
        archiveMissingEmitted = true;
        archiveHookConfigured = false;
      } else if (res.status === "unsafe") {
        findings.push({
          code: "unsafe_symlink",
          severity: "error",
          file: sanitizeSafeToken(ref),
          message: `Refused unsafe archive script path (${res.reason})`,
        });
      }
    }
  }

  const setupScriptOnDisk =
    scriptReadCache.get("scripts/orca-worktree-setup.sh")?.status === "ok";
  const archiveScriptOnDisk =
    scriptReadCache.get("scripts/orca-worktree-archive.sh")?.status === "ok";

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
    if (res.status === "unsafe" && !setupRefs.includes(scriptPath) && !archiveRefs.includes(scriptPath)) {
      findings.push({
        code: "unsafe_symlink",
        severity: "error",
        file: sanitizeSafeToken(scriptPath),
        message: `Refused unsafe hook script (${res.reason})`,
      });
    } else if (res.status === "ok") {
      if (res.content.trim().length === 0) {
        findings.push({
          code: "empty_hook_script",
          severity: "warning",
          file: scriptPath,
          message: `Hook script ${scriptPath} is empty`,
        });
      } else if (hasHardcodedHomePath(res.content)) {
        findings.push({
          code: "hardcoded_home_path",
          severity: "warning",
          file: scriptPath,
          message: `Hook script ${scriptPath} references a hardcoded user home directory path`,
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
): AuditedRepoReport {
  const sourceOrder: RepoSource[] = ["orca", "portfolio", "explicit"];
  const sources = sourceOrder.filter((s) => target.sources.has(s));
  return {
    name: target.name,
    path: redactedPath,
    sources,
    commandSourcePolicy,
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

  const resolution = (deps.resolve ?? resolveOrca)();
  if (resolution.status === "refused") {
    const payload = {
      status: "refused" as const,
      platform: resolution.platform,
      scope,
      reason: resolution.reason,
      suggestions: resolution.suggestions,
      summary: emptySummary(),
      repos: [],
    };
    if (json) {
      return JSON.stringify({ hooksAudit: payload }, null, 2);
    }
    return toon({ hooksAudit: payload }, helpBlock(resolution.suggestions));
  }

  let orcaRepos: OrcaRegisteredRepo[] = [];
  let orcaErrorReason: string | undefined =
    resolution.status !== "ok" ? resolution.reason : undefined;
  if (resolution.status === "ok" && resolution.binary) {
    try {
      const rawList = (deps.runOrcaRepoList ?? defaultRunOrcaRepoList)(resolution.binary.path);
      orcaRepos = parseOrcaRepoList(rawList);
    } catch (err) {
      orcaErrorReason =
        err instanceof AxiError
          ? err.message
          : "Failed to query `orca repo list --json`";
      if (scope === "registered") {
        const payload = {
          status: "error" as const,
          platform: resolution.platform,
          scope,
          reason: orcaErrorReason,
          suggestions: [
            "Ensure the Orca runtime daemon is running and `orca repo list --json` succeeds",
            "Or pass `--repo <path>` / `--all` to audit on-disk repositories",
          ],
          summary: emptySummary(),
          repos: [],
        };
        if (json) {
          return JSON.stringify({ hooksAudit: payload }, null, 2);
        }
        return toon({ hooksAudit: payload }, helpBlock(payload.suggestions));
      }
    }
  } else if (scope === "registered") {
    const payload = {
      status: "error" as const,
      platform: resolution.platform,
      scope,
      reason: resolution.reason ?? "No Orca terminal/session runtime binary was found.",
      suggestions: resolution.suggestions,
      summary: emptySummary(),
      repos: [],
    };
    if (json) {
      return JSON.stringify({ hooksAudit: payload }, null, 2);
    }
    return toon({ hooksAudit: payload }, helpBlock(resolution.suggestions));
  }

  const orcaByKey = new Map<string, OrcaRegisteredRepo>();
  for (const r of orcaRepos) {
    orcaByKey.set(normalizePathKey(r.path), r);
  }

  const targetsByKey = new Map<string, AuditTarget>();
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
      } else if (resolution.status !== "ok") {
        const payload = {
          status: "error" as const,
          platform: resolution.platform,
          scope,
          reason:
            resolution.reason ??
            catalogResult.error ??
            "Neither Orca CLI nor portfolio catalog is available.",
          suggestions: resolution.suggestions,
          summary: emptySummary(),
          repos: [],
        };
        if (json) {
          return JSON.stringify({ hooksAudit: payload }, null, 2);
        }
        return toon({ hooksAudit: payload }, helpBlock(resolution.suggestions));
      }
    }
  }

  const orderedTargets = [...targetsByKey.values()].sort(
    (a, b) => a.name.localeCompare(b.name) || a.fsPath.localeCompare(b.fsPath),
  );
  const reports = orderedTargets.map((t) => auditTargetRepo(t, effectiveHome));
  const summary = summarizeReports(reports);

  if (json) {
    return JSON.stringify(
      {
        hooksAudit: {
          status: resolution.status,
          platform: resolution.platform,
          scope,
          ...(orcaErrorReason ? { orcaReason: orcaErrorReason } : {}),
          summary,
          repos: reports,
        },
      },
      null,
      2,
    );
  }

  const activeCodeCounts = Object.fromEntries(
    Object.entries(summary.byCode).filter(([, count]) => count > 0),
  );

  const compactView = {
    hooksAudit: {
      status: resolution.status,
      platform: resolution.platform,
      scope,
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

  return toon(
    compactView,
    helpBlock([
      "Run `orca-axi hooks-audit --json` for structured findings and per-file details",
      "Run `orca-axi hooks-audit --all` to include portfolio-catalog.json repositories",
    ]),
  );
}
