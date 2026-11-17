import type { AgentHarness } from "./types.js";

export interface ClassifiedProcess {
  readonly pid: number;
  readonly ppid: number;
  readonly tty: string | null;
  readonly stat: string;
  readonly cpuPercent: number;
  readonly elapsed: string;
  readonly harness: AgentHarness;
  readonly sessionId: string | null;
  readonly command: string;
}

export interface BridgeProcessInfo {
  readonly bridgePid: number;
  readonly bridgeTty: string | null;
  readonly watchPid: number;
  readonly conversationId: string;
}

const NOISE_PATTERNS: readonly RegExp[] = [
  /--claude-in-chrome-mcp/i,
  /mcp-server/i,
  /statusline-command\.sh/i,
  /fm-sessionstart-run\.sh/i,
  /--type=(?:gpu-process|renderer|utility|zygote|broker)/i,
  /crashpad/i,
  /\bShipIt\b/i,
  /\bSparkle\b/i,
  /\bAutoupdate\b/i,
  /Updater\.app/i,
  /CursorUIViewService/i,
  /SkyComputerUseService/i,
  /ChatGPT for Chrome/i,
  /codex-code-mode-host/i,
  /\bcodex(?:\s+[^\s]+)*\s+app-server\b/i,
  /\bcodex(?:\s+[^\s]+)*\s+exec-server\b/i,
  /\bopencode\s+(?:serve|acp)\b/i,
  /\/Claude\.app\/Contents\//i,
  /(?:hermes_cli\.main|sys\.argv\[0\]\s*=\s*['"]hermes['"]).*\bdashboard\b/i,
  /\bxvfb-run\b/i,
  /\bs6-supervise\b/i,
  /\brc\.init\b/i,
  /process_supervisor\.sh/i,
  /\borca-axi\b/i,
  /\bfm-fleet-agents\b/i,
  /\bagy-handoff\b/i,
  /\b(?:pyright|tsserver|rust-analyzer|gopls|eslint_d)\b/i,
];

const SECRET_PATTERNS: readonly RegExp[] = [
  /(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi,
  /((?:--?(?:api[-_]?key|token|secret|password|auth))[=\s]+)\S+/gi,
  /\b(?:sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,}|xox[baprs]-[A-Za-z0-9-]{8,})\b/g,
];

export function sanitizeCommandPreview(raw: string, maxLen = 160): string {
  let text = raw.replace(/\s+/g, " ").trim();
  for (const pattern of SECRET_PATTERNS) {
    text = text.replace(pattern, (_match, prefix?: string) =>
      typeof prefix === "string" ? `${prefix}[REDACTED]` : "[REDACTED]",
    );
  }
  return text.length <= maxLen ? text : `${text.slice(0, maxLen - 1)}…`;
}

function normalizeTty(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed === "?" || trimmed === "??") {
    return null;
  }
  return trimmed.replace(/^\/dev\//, "");
}

function extractArgvSessionId(command: string): string | null {
  const convMatch =
    /(?:--conversation|--resume|-r)(?:=|\s+)([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|\b[A-Za-z0-9_-]{8,64}\b)/.exec(
      command,
    );
  return convMatch?.[1] ?? null;
}

function detectHarness(command: string): AgentHarness | null {
  const trimmed = command.trim();
  if (!trimmed) return null;

  for (const pattern of NOISE_PATTERNS) {
    if (pattern.test(trimmed)) return null;
  }

  // Extract executable token (handling paths with spaces such as `/opt/Grok Bot/grok-bot` or `.app/Contents/MacOS/...`)
  const appMacOsMatch = /^(\/[^\n]*?\.app\/Contents\/MacOS\/[^/\s]+(?:\s+Bot)?)(?:\s|$)/.exec(
    trimmed,
  );
  const optSpaceMatch = /^(\/opt\/Grok Bot\/grok-bot)(?:\s|$)/i.exec(trimmed);
  const firstToken = appMacOsMatch?.[1] ?? optSpaceMatch?.[1] ?? trimmed.split(/\s+/, 1)[0] ?? "";
  const base = firstToken.split("/").pop()?.replace(/^-/, "") ?? "";
  const lowerBase = base.toLowerCase();

  // Never match search/shell wrappers whose argv merely mentions agent names
  if (
    lowerBase === "grep" ||
    lowerBase === "egrep" ||
    lowerBase === "rg" ||
    lowerBase === "awk" ||
    lowerBase === "sed" ||
    lowerBase === "ps" ||
    lowerBase === "sh" ||
    lowerBase === "bash" ||
    lowerBase === "zsh"
  ) {
    return null;
  }

  if (lowerBase === "agy") return "agy";
  if (lowerBase === "claude" || /\/claude\/versions\/[^/\s]+$/.test(firstToken)) return "claude";
  if (
    lowerBase === "codex" ||
    /\/@openai\/codex[^/\s]*\/.*\/codex$/.test(firstToken) ||
    /CodexCLI\.app\/Contents\/MacOS\/codex$/i.test(firstToken)
  ) {
    // Ignore ChatGPT desktop browser helpers unless it is CodexCLI or terminal codex
    if (trimmed.includes("ChatGPT.app") && !trimmed.includes("CodexCLI.app")) {
      return null;
    }
    return "codex";
  }
  if (lowerBase === "grok" || lowerBase === "grok-bot" || lowerBase === "grok bot") {
    if (trimmed.includes("Helper.app")) return null;
    return "grok";
  }
  if (lowerBase === "opencode") {
    // Exclude non-interactive `opencode run` subcommands if needed? Keep real opencode sessions
    return "opencode";
  }
  if (lowerBase === "cursor-agent" || /\/cursor-agent\/versions\/[^/]+\//.test(firstToken)) {
    return "cursor";
  }

  // Interpreter-wrapped harnesses: node / python
  if (/^(?:node|node\d*|bun)$/.test(lowerBase)) {
    const tokens = trimmed.split(/\s+/).slice(1);
    const scriptToken = tokens.find((t) => !t.startsWith("-")) ?? "";
    const scriptBase = scriptToken.split("/").pop()?.toLowerCase() ?? "";
    if (scriptBase === "gemini" || scriptToken.includes("/@google/gemini-cli/")) return "gemini";
    if (scriptBase === ".cline" || scriptBase === "cline" || /\/cline\/bin\//.test(scriptToken)) {
      return "cline";
    }
    if (scriptBase === "codex") return "codex";
    if (scriptBase === "claude") return "claude";
    if (scriptBase === "cursor-agent") return "cursor";
    return null;
  }

  if (/^python(?:\d+(?:\.\d+)?)?$/.test(lowerBase)) {
    if (/\bhermes_cli\.main\b/.test(trimmed) || /\bsys\.argv\[0\]\s*=\s*['"]hermes['"]/.test(trimmed)) {
      return "hermes";
    }
    return null;
  }

  if (lowerBase === "gemini") return "gemini";
  if (lowerBase === "cline" || lowerBase === ".cline") return "cline";
  if (lowerBase === "hermes") return "hermes";

  return null;
}

const PS_LINE_RE =
  /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+([0-9]+(?:\.[0-9]+)?)\s+(\S+)\s+(.+)$/;

export function parseBridgeProcessLine(line: string): BridgeProcessInfo | null {
  const match = PS_LINE_RE.exec(line);
  if (!match) return null;
  const pid = Number(match[1]);
  const tty = normalizeTty(match[3] ?? "");
  const command = match[7] ?? "";
  if (!command.includes("agy-session-bridge.py")) return null;
  const convMatch = /--conversation\s+([0-9a-fA-F-]{36})/.exec(command);
  const watchMatch = /--watch-pid\s+(\d+)/.exec(command);
  if (!convMatch?.[1] || !watchMatch?.[1]) return null;
  return {
    bridgePid: pid,
    bridgeTty: tty,
    watchPid: Number(watchMatch[1]),
    conversationId: convMatch[1],
  };
}

export function classifyProcessLine(line: string): ClassifiedProcess | null {
  const match = PS_LINE_RE.exec(line);
  if (!match) return null;
  const pid = Number(match[1]);
  const ppid = Number(match[2]);
  const tty = normalizeTty(match[3] ?? "");
  const stat = match[4] ?? "";
  const cpuPercent = Number(match[5] ?? "0");
  const elapsed = match[6] ?? "";
  const rawCommand = match[7] ?? "";

  if (stat.startsWith("Z") || rawCommand.includes("<defunct>")) {
    return null;
  }

  const harness = detectHarness(rawCommand);
  if (!harness) return null;

  return {
    pid,
    ppid,
    tty,
    stat,
    cpuPercent: Number.isFinite(cpuPercent) ? cpuPercent : 0,
    elapsed,
    harness,
    sessionId: extractArgvSessionId(rawCommand),
    command: sanitizeCommandPreview(rawCommand),
  };
}

export function parsePsOutput(psText: string): ClassifiedProcess[] {
  const results: ClassifiedProcess[] = [];
  for (const line of psText.split(/\r?\n/)) {
    const classified = classifyProcessLine(line);
    if (classified) {
      results.push(classified);
    }
  }
  return results;
}

export function extractLinearIssue(
  explicitIssue: string | null | undefined,
  branch: string | null | undefined,
): string | null {
  if (explicitIssue) {
    const direct = /\b([A-Za-z]{2,10}-\d+)\b/.exec(explicitIssue);
    if (direct?.[1]) return direct[1].toUpperCase();
  }
  if (branch) {
    const fromBranch = /\b(cyb-\d+|[a-z]{2,8}-\d+)\b/i.exec(branch);
    if (fromBranch?.[1]) {
      const candidate = fromBranch[1].toUpperCase();
      // Avoid misreading git refs or date fragments like UTF-8 / M3-20261101
      if (!/^(?:UTF|ISO|SHA|PR|MR|V\d|M\d+-\d{6,})-/i.test(candidate) && !/-\d{6,}$/.test(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

export function inferProjectFromPath(
  cwdOrRepo: string | null | undefined,
  orcaProjectId?: string | null,
): string {
  if (orcaProjectId) {
    const slug = orcaProjectId.split("/").pop()?.trim();
    if (slug) return slug;
  }
  if (!cwdOrRepo) return "unassigned";
  const normalized = cwdOrRepo.replace(/\/+$/, "");
  if (!normalized || normalized === "/") return "system";

  // Orca workspace path: .../orca/workspaces/<project>/<worktree>
  const orcaWs = /\/orca\/workspaces\/([^/]+)\/[^/]+/.exec(normalized);
  if (orcaWs?.[1]) return orcaWs[1];

  // FirstMate treehouse pool: .../.fm-pools/<pool>/.treehouse/<slot>/<n>/<repo>
  const treehouse = /\/\.treehouse\/[^/]+\/\d+\/([^/]+)/.exec(normalized);
  if (treehouse?.[1]) return treehouse[1];

  // Dev / Projects / GitHub roots
  const devMatch = /\/(?:dev|projects|GitHub|apps|orca)\/([^/]+)/.exec(normalized);
  if (devMatch?.[1] && devMatch[1] !== "workspaces" && devMatch[1] !== "projects") {
    return devMatch[1];
  }

  // Home directory itself
  if (/^\/(?:Users|home)\/[^/]+$/.test(normalized)) {
    return "home-captain";
  }

  return normalized.split("/").pop() || "unassigned";
}
