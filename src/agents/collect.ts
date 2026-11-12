import { execFile, spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { hostname as osHostname, homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { resolveOrca } from "../orca-resolve.js";
import { inferProjectFromPath, parsePsOutput } from "./classify.js";
import {
  correlateHostAgents,
  mergeFleetReport,
  type GitDirInfo,
  type HerdrAgentSnapshot,
  type OrcaTerminalSnapshot,
  type OrcaWorktreeSnapshot,
  type TmuxPaneSnapshot,
} from "./correlate.js";
import type { DocPresence, FleetAgentsReport, HostScanResult } from "./types.js";

const execFileAsync = promisify(execFile);

export interface RemoteHostSpec {
  readonly host: string;
  readonly sshTargets: readonly string[];
}

export const DEFAULT_REMOTE_FLEET: readonly RemoteHostSpec[] = [
  { host: "adi1", sshTargets: ["adi1"] },
  { host: "adi2", sshTargets: ["adi2-ts", "adi2"] },
  { host: "macmini", sshTargets: ["macmini"] },
  { host: "adi4", sshTargets: ["adihost4", "adi4"] },
];

const SAFE_HOST_RE = /^[A-Za-z0-9._@-]+$/;

function validateHostSelector(target: string): string {
  const trimmed = target.trim();
  if (!trimmed || !SAFE_HOST_RE.test(trimmed) || trimmed.startsWith("-")) {
    throw new Error(`Invalid SSH host selector: ${target}`);
  }
  return trimmed;
}

export function normalizeLocalHostName(raw: string = osHostname()): string {
  const short = raw.split(".")[0]?.trim().toLowerCase() ?? "local";
  if (short.includes("mini")) return "macmini";
  if (short === "srv2083966" || short === "adihost4") return "adi4";
  return short || "local";
}

async function runCmd(
  bin: string,
  args: readonly string[],
  timeoutMs = 3500,
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(bin, [...args], {
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      encoding: "utf8",
    });
    return stdout;
  } catch {
    return null;
  }
}

export function parseLsofCwds(lsofFnOutput: string): Map<number, string> {
  const map = new Map<number, string>();
  let currentPid: number | null = null;
  for (const line of lsofFnOutput.split(/\r?\n/)) {
    if (line.startsWith("p")) {
      const parsed = Number(line.slice(1));
      currentPid = Number.isFinite(parsed) ? parsed : null;
    } else if (line.startsWith("n") && currentPid !== null && line.length > 1) {
      map.set(currentPid, line.slice(1));
    }
  }
  return map;
}

export function parseLsofAgyLocks(lsofFnOutput: string): Map<number, string> {
  const map = new Map<number, string>();
  let currentPid: number | null = null;
  const lockRe = /\/antigravity-cli\/presence\/([0-9a-fA-F-]{36})\.lock$/;
  for (const line of lsofFnOutput.split(/\r?\n/)) {
    if (line.startsWith("p")) {
      const parsed = Number(line.slice(1));
      currentPid = Number.isFinite(parsed) ? parsed : null;
    } else if (line.startsWith("n") && currentPid !== null) {
      const m = lockRe.exec(line.slice(1));
      if (m?.[1]) {
        map.set(currentPid, m[1]);
      }
    }
  }
  return map;
}

export function parseTmuxPaneLines(lines: readonly string[]): TmuxPaneSnapshot[] {
  const panes: TmuxPaneSnapshot[] = [];
  for (const raw of lines) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    // Format: session:win.pane\tpane_pid\tpane_tty\tpane_current_path\twindow_name
    // Or space-separated fallback
    const tabParts = trimmed.split("\t");
    if (tabParts.length >= 5) {
      panes.push({
        paneRef: tabParts[0] ?? "",
        panePid: Number(tabParts[1] ?? "0"),
        paneTty: (tabParts[2] ?? "").replace(/^\/dev\//, "") || null,
        panePath: tabParts[3] || null,
        windowName: tabParts[4] || null,
      });
      continue;
    }
    const spaceMatch = /^(\S+)\s+(\d+)\s+(\S+)\s+(\S+)\s*(.*)$/.exec(trimmed);
    if (spaceMatch) {
      panes.push({
        paneRef: spaceMatch[1] ?? "",
        panePid: Number(spaceMatch[2] ?? "0"),
        paneTty: (spaceMatch[3] ?? "").replace(/^\/dev\//, "") || null,
        panePath: spaceMatch[4] || null,
        windowName: spaceMatch[5] || null,
      });
    }
  }
  return panes;
}

export function checkDocPresence(dir: string): DocPresence {
  const readme = existsSync(join(dir, "README.md")) || existsSync(join(dir, "readme.md"));
  const roadmap =
    existsSync(join(dir, "ROADMAP.md")) ||
    existsSync(join(dir, "docs/ROADMAP.md")) ||
    existsSync(join(dir, "VISION.md"));
  const plans =
    existsSync(join(dir, "Plans")) ||
    existsSync(join(dir, "plans")) ||
    existsSync(join(dir, "docs/plans"));
  return { readme, roadmap, plans };
}

async function inspectLocalGitDir(dir: string): Promise<GitDirInfo> {
  const gitOut = await runCmd("git", ["-C", dir, "rev-parse", "--show-toplevel", "--abbrev-ref", "HEAD"], 1500);
  if (!gitOut) {
    return { repoPath: null, branch: null, docs: checkDocPresence(dir) };
  }
  const lines = gitOut
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  const repoPath = lines[0] ?? dir;
  const branch = lines[1] && lines[1] !== "HEAD" ? lines[1] : null;
  return {
    repoPath,
    branch,
    docs: checkDocPresence(repoPath),
  };
}

interface OrcaEnvironmentSnapshot {
  readonly worktrees: OrcaWorktreeSnapshot[];
  readonly terminals: OrcaTerminalSnapshot[];
}

async function collectOrcaSnapshots(orcaBin: string | undefined): Promise<{
  local: OrcaEnvironmentSnapshot;
  byRemoteHost: Map<string, OrcaEnvironmentSnapshot>;
}> {
  const empty: OrcaEnvironmentSnapshot = { worktrees: [], terminals: [] };
  const byRemoteHost = new Map<string, OrcaEnvironmentSnapshot>();
  if (!orcaBin) return { local: empty, byRemoteHost };

  const [wtRaw, termRaw] = await Promise.all([
    runCmd(orcaBin, ["worktree", "list", "--json"], 3500),
    runCmd(orcaBin, ["terminal", "list", "--json"], 3500),
  ]);

  const parseWorktrees = (raw: string | null): OrcaWorktreeSnapshot[] => {
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw) as {
        result?: { worktrees?: Array<Record<string, unknown>> };
      };
      return (parsed.result?.worktrees ?? [])
        .filter((w) => typeof w.path === "string")
        .map((w) => ({
          id: String(w.id ?? w.path),
          path: String(w.path),
          projectId: typeof w.projectId === "string" ? w.projectId : null,
          branch: typeof w.branch === "string" ? w.branch : null,
          linkedLinearIssue: typeof w.linkedLinearIssue === "string" ? w.linkedLinearIssue : null,
          lastActivityAt: typeof w.lastActivityAt === "number" ? w.lastActivityAt : null,
        }));
    } catch {
      return [];
    }
  };

  const parseTerminals = (
    raw: string | null,
  ): { terminals: OrcaTerminalSnapshot[]; envNames: string[] } => {
    if (!raw) return { terminals: [], envNames: [] };
    try {
      const parsed = JSON.parse(raw) as {
        result?: {
          terminals?: Array<Record<string, unknown>>;
          hostScope?: { omittedHostSelectors?: Array<{ selector?: string }> };
        };
      };
      const terminals = (parsed.result?.terminals ?? []).map((t) => ({
        handle: String(t.handle ?? ""),
        worktreePath: typeof t.worktreePath === "string" ? t.worktreePath : null,
        title: typeof t.title === "string" ? t.title : null,
        lastOutputAt: typeof t.lastOutputAt === "number" ? t.lastOutputAt : null,
      }));
      const envNames = (parsed.result?.hostScope?.omittedHostSelectors ?? [])
        .map((s) => {
          const m = /--environment\s+(\S+)/.exec(String(s.selector ?? ""));
          return m?.[1] ?? null;
        })
        .filter((x): x is string => x !== null);
      return { terminals, envNames };
    } catch {
      return { terminals: [], envNames: [] };
    }
  };

  const localWts = parseWorktrees(wtRaw);
  const { terminals: localTerms, envNames } = parseTerminals(termRaw);

  await Promise.all(
    envNames.map(async (envName) => {
      if (!SAFE_HOST_RE.test(envName)) return;
      const [rWt, rTerm] = await Promise.all([
        runCmd(orcaBin, ["worktree", "list", "--environment", envName, "--json"], 2500),
        runCmd(orcaBin, ["terminal", "list", "--environment", envName, "--json"], 2500),
      ]);
      byRemoteHost.set(envName.toLowerCase(), {
        worktrees: parseWorktrees(rWt),
        terminals: parseTerminals(rTerm).terminals,
      });
    }),
  );

  return {
    local: { worktrees: localWts, terminals: localTerms },
    byRemoteHost,
  };
}

async function collectLocalHerdr(): Promise<HerdrAgentSnapshot[]> {
  const results: HerdrAgentSnapshot[] = [];
  for (const session of ["default", "fm-remote"]) {
    const [wsRaw, agRaw] = await Promise.all([
      runCmd("herdr", ["--session", session, "workspace", "list"], 2000),
      runCmd("herdr", ["--session", session, "agent", "list"], 2000),
    ]);
    const wsLabels = new Map<string, string>();
    if (wsRaw) {
      try {
        const wsParsed = JSON.parse(wsRaw) as {
          result?: { workspaces?: Array<{ workspace_id?: string; label?: string }> };
        };
        for (const w of wsParsed.result?.workspaces ?? []) {
          if (w.workspace_id && w.label) {
            wsLabels.set(w.workspace_id, w.label);
          }
        }
      } catch {
        // ignore
      }
    }
    if (agRaw) {
      try {
        const agParsed = JSON.parse(agRaw) as {
          result?: {
            agents?: Array<{
              agent?: string;
              agent_status?: string;
              cwd?: string;
              pane_id?: string;
              workspace_id?: string;
              terminal_title_stripped?: string;
              terminal_title?: string;
              agent_session?: { value?: string };
            }>;
          };
        };
        for (const a of agParsed.result?.agents ?? []) {
          if (!a.agent || !a.pane_id || !a.workspace_id) continue;
          results.push({
            session,
            agent: a.agent,
            agentStatus: a.agent_status ?? "unknown",
            cwd: a.cwd ?? null,
            paneId: a.pane_id,
            workspaceId: a.workspace_id,
            workspaceLabel: wsLabels.get(a.workspace_id) ?? null,
            sessionId: a.agent_session?.value ?? null,
            title: a.terminal_title_stripped ?? a.terminal_title ?? null,
          });
        }
      } catch {
        // ignore
      }
    }
  }
  return results;
}

export async function collectLocalMachine(
  localHost: string,
  orcaLocal: OrcaEnvironmentSnapshot,
): Promise<HostScanResult> {
  const started = Date.now();
  const psArgs =
    process.platform === "darwin"
      ? ["-ww", "-Ao", "pid,ppid,tty,stat,%cpu,etime,command"]
      : ["-ww", "-Ao", "pid,ppid,tty,stat,%cpu,etime,args"];
  const psText = (await runCmd("ps", psArgs, 3000)) ?? "";
  const candidateProcs = parsePsOutput(psText);
  const pidList = candidateProcs.map((p) => p.pid);
  const agyPids = candidateProcs.filter((p) => p.harness === "agy").map((p) => p.pid);

  const [cwdOut, agyFilesOut, herdrAgents, tmuxOut] = await Promise.all([
    pidList.length > 0
      ? runCmd("lsof", ["-a", "-p", pidList.join(","), "-d", "cwd", "-Fn"], 2500)
      : Promise.resolve(null),
    agyPids.length > 0
      ? runCmd("lsof", ["-p", agyPids.join(","), "-Fn"], 2500)
      : Promise.resolve(null),
    collectLocalHerdr(),
    runCmd(
      "tmux",
      [
        "list-panes",
        "-a",
        "-F",
        "#{session_name}:#{window_index}.#{pane_index}\t#{pane_pid}\t#{pane_tty}\t#{pane_current_path}\t#{window_name}",
      ],
      1500,
    ),
  ]);

  const cwdsByPid = cwdOut ? parseLsofCwds(cwdOut) : new Map<number, string>();
  const agyLocksByPid = agyFilesOut ? parseLsofAgyLocks(agyFilesOut) : new Map<number, string>();
  const agyTranscriptMtimeByConv = new Map<string, number>();
  const home = homedir();
  for (const convId of agyLocksByPid.values()) {
    const txPath = join(
      home,
      ".gemini/antigravity-cli/brain",
      convId,
      ".system_generated/logs/transcript.jsonl",
    );
    try {
      const st = statSync(txPath);
      agyTranscriptMtimeByConv.set(convId, Math.round(st.mtimeMs));
    } catch {
      // ignore
    }
  }

  const uniqueDirs = Array.from(
    new Set(
      [...cwdsByPid.values(), ...herdrAgents.map((h) => h.cwd).filter((x): x is string => Boolean(x))],
    ),
  );
  const gitEntries = await Promise.all(
    uniqueDirs.map(async (dir) => [dir, await inspectLocalGitDir(dir)] as const),
  );
  const gitInfoByDir = new Map<string, GitDirInfo>(gitEntries);

  const tmuxPanes = tmuxOut ? parseTmuxPaneLines(tmuxOut.split(/\r?\n/)) : [];
  const agents = correlateHostAgents({
    host: localHost,
    psText,
    cwdsByPid,
    agyLocksByPid,
    agyTranscriptMtimeByConv,
    orcaWorktrees: orcaLocal.worktrees,
    orcaTerminals: orcaLocal.terminals,
    herdrAgents,
    tmuxPanes,
    gitInfoByDir,
  });

  const docsByProject = new Map<string, DocPresence>();
  for (const info of gitInfoByDir.values()) {
    if (info.repoPath) {
      docsByProject.set(inferProjectFromPath(info.repoPath), info.docs);
    }
  }
  for (const wt of orcaLocal.worktrees) {
    const proj = inferProjectFromPath(wt.path, wt.projectId);
    if (!docsByProject.has(proj) && existsSync(wt.path)) {
      docsByProject.set(proj, checkDocPresence(wt.path));
    }
  }

  return {
    status: {
      host: localHost,
      reachable: true,
      agentCount: agents.length,
      workingCount: agents.filter((a) => a.state === "working" || a.state === "bridged").length,
      durationMs: Date.now() - started,
    },
    agents,
    docsByProject,
  };
}

const REMOTE_PYTHON_PROBE = `
import json, os, platform, re, subprocess

def run(cmd, timeout=2.0):
    try:
        return subprocess.check_output(cmd, text=True, stderr=subprocess.DEVNULL, timeout=timeout)
    except Exception:
        return ""

env_path = os.path.expanduser("~/.local/bin") + ":/opt/homebrew/bin:/usr/local/bin:/usr/sbin:/sbin:" + os.environ.get("PATH", "")
os.environ["PATH"] = env_path

ps_cmd = ["ps", "-ww", "-Ao", "pid,ppid,tty,stat,%cpu,etime,command"] if platform.system() == "Darwin" else ["ps", "-ww", "-Ao", "pid,ppid,tty,stat,%cpu,etime,args"]
ps_text = run(ps_cmd, 2.5)
cand_pids = []
for ln in ps_text.splitlines()[1:]:
    low = ln.lower()
    if any(k in low for k in ("claude", "codex", "agy", "grok", "opencode", "cursor-agent", "gemini", "cline", "hermes")):
        m = re.match(r"^\\s*(\\d+)\\b", ln)
        if m:
            cand_pids.append(int(m.group(1)))

cwds = {}
if cand_pids:
    if platform.system() == "Linux":
        for pid in cand_pids:
            try:
                cwds[str(pid)] = os.readlink(f"/proc/{pid}/cwd")
            except OSError:
                pass
    else:
        out = run(["lsof", "-a", "-p", ",".join(str(p) for p in cand_pids), "-d", "cwd", "-Fn"], 2.0)
        cur = None
        for ln in out.splitlines():
            if ln.startswith("p"):
                cur = ln[1:]
            elif ln.startswith("n") and cur:
                cwds[cur] = ln[1:]

tmux_out = run(["tmux", "list-panes", "-a", "-F", "#{session_name}:#{window_index}.#{pane_index}\\t#{pane_pid}\\t#{pane_tty}\\t#{pane_current_path}\\t#{window_name}"], 1.5)
tmux_lines = [l for l in tmux_out.splitlines() if l.strip()]

herdr_agents = []
for sess in ("default", "fm-remote"):
    ag_raw = run(["herdr", "--session", sess, "agent", "list"], 1.5)
    if not ag_raw:
        continue
    ws_raw = run(["herdr", "--session", sess, "workspace", "list"], 1.5)
    ws_labels = {}
    try:
        for w in json.loads(ws_raw).get("result", {}).get("workspaces", []):
            ws_labels[w.get("workspace_id", "")] = w.get("label", "")
    except Exception:
        pass
    try:
        for a in json.loads(ag_raw).get("result", {}).get("agents", []):
            wid = a.get("workspace_id", "")
            herdr_agents.append({
                "session": sess,
                "agent": a.get("agent", ""),
                "agentStatus": a.get("agent_status", "unknown"),
                "cwd": a.get("cwd"),
                "paneId": a.get("pane_id", ""),
                "workspaceId": wid,
                "workspaceLabel": ws_labels.get(wid),
                "sessionId": (a.get("agent_session") or {}).get("value"),
                "title": a.get("terminal_title_stripped") or a.get("terminal_title"),
            })
    except Exception:
        pass

dirs = set(cwds.values()) | {a["cwd"] for a in herdr_agents if a.get("cwd")}
git_by_dir = {}
for d in list(dirs)[:25]:
    if not d or not os.path.isdir(d):
        continue
    g = run(["git", "-C", d, "rev-parse", "--show-toplevel", "--abbrev-ref", "HEAD"], 1.2).splitlines()
    repo = g[0].strip() if len(g) >= 1 else d
    branch = g[1].strip() if len(g) >= 2 and g[1].strip() != "HEAD" else None
    docs = {
        "readme": os.path.exists(os.path.join(repo, "README.md")) or os.path.exists(os.path.join(repo, "readme.md")),
        "roadmap": os.path.exists(os.path.join(repo, "ROADMAP.md")) or os.path.exists(os.path.join(repo, "docs/ROADMAP.md")) or os.path.exists(os.path.join(repo, "VISION.md")),
        "plans": os.path.exists(os.path.join(repo, "Plans")) or os.path.exists(os.path.join(repo, "plans")) or os.path.exists(os.path.join(repo, "docs/plans")),
    }
    git_by_dir[d] = {"repoPath": repo, "branch": branch, "docs": docs}

print(json.dumps({
    "psText": ps_text,
    "cwds": cwds,
    "tmuxLines": tmux_lines,
    "herdrAgents": herdr_agents,
    "gitByDir": git_by_dir,
}))
`.trim();

export type SshProbeRunner = (sshTarget: string) => Promise<string>;

export async function defaultSshProbeRunner(sshTarget: string): Promise<string> {
  const safeTarget = validateHostSelector(sshTarget);
  return new Promise<string>((resolve, reject) => {
    const child = spawn(
      "ssh",
      [
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=2",
        "-o",
        "StrictHostKeyChecking=accept-new",
        safeTarget,
        "python3",
        "-",
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`SSH probe timed out after 5s (${safeTarget})`));
    }, 5000);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0 && stdout.trim()) {
        resolve(stdout.trim());
      } else {
        reject(new Error(stderr.trim() || `ssh exited with code ${code ?? -1}`));
      }
    });

    child.stdin.write(REMOTE_PYTHON_PROBE);
    child.stdin.end();
  });
}

interface RemoteProbePayload {
  psText?: string;
  cwds?: Record<string, string>;
  tmuxLines?: string[];
  herdrAgents?: HerdrAgentSnapshot[];
  gitByDir?: Record<string, GitDirInfo>;
}

export async function collectRemoteMachine(
  spec: RemoteHostSpec,
  runner: SshProbeRunner = defaultSshProbeRunner,
  orcaRemote: OrcaEnvironmentSnapshot = { worktrees: [], terminals: [] },
): Promise<HostScanResult> {
  const started = Date.now();
  let lastError = "No SSH targets configured";

  for (const target of spec.sshTargets) {
    try {
      const rawJson = await runner(target);
      const payload = JSON.parse(rawJson) as RemoteProbePayload;
      const cwdsByPid = new Map<number, string>();
      for (const [k, v] of Object.entries(payload.cwds ?? {})) {
        const pid = Number(k);
        if (Number.isFinite(pid) && typeof v === "string") {
          cwdsByPid.set(pid, v);
        }
      }
      const gitInfoByDir = new Map<string, GitDirInfo>(Object.entries(payload.gitByDir ?? {}));
      const tmuxPanes = parseTmuxPaneLines(payload.tmuxLines ?? []);
      const agents = correlateHostAgents({
        host: spec.host,
        psText: payload.psText ?? "",
        cwdsByPid,
        orcaWorktrees: orcaRemote.worktrees,
        orcaTerminals: orcaRemote.terminals,
        herdrAgents: payload.herdrAgents ?? [],
        tmuxPanes,
        gitInfoByDir,
      });

      const docsByProject = new Map<string, DocPresence>();
      for (const info of gitInfoByDir.values()) {
        if (info.repoPath) {
          docsByProject.set(inferProjectFromPath(info.repoPath), info.docs);
        }
      }

      return {
        status: {
          host: spec.host,
          reachable: true,
          agentCount: agents.length,
          workingCount: agents.filter((a) => a.state === "working" || a.state === "bridged").length,
          durationMs: Date.now() - started,
        },
        agents,
        docsByProject,
      };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }

  return {
    status: {
      host: spec.host,
      reachable: false,
      agentCount: 0,
      workingCount: 0,
      durationMs: Date.now() - started,
      error: lastError.split(/\r?\n/)[0] ?? "unreachable",
    },
    agents: [],
    docsByProject: new Map(),
  };
}

export interface CollectFleetOptions {
  readonly allMachines?: boolean;
  readonly remoteSpecs?: readonly RemoteHostSpec[];
  readonly sshRunner?: SshProbeRunner;
}

export async function collectFleetAgents(
  options: CollectFleetOptions = {},
): Promise<FleetAgentsReport> {
  const localHost = normalizeLocalHostName();
  const resolution = resolveOrca();
  const orcaBin = resolution.status === "ok" ? resolution.binary?.path : undefined;
  const orcaSnapshots = await collectOrcaSnapshots(orcaBin);

  const remoteSpecs = options.allMachines
    ? (options.remoteSpecs ?? DEFAULT_REMOTE_FLEET).filter((spec) => spec.host !== localHost)
    : [];

  const [localResult, ...remoteResults] = await Promise.all([
    collectLocalMachine(localHost, orcaSnapshots.local),
    ...remoteSpecs.map((spec) =>
      collectRemoteMachine(
        spec,
        options.sshRunner,
        orcaSnapshots.byRemoteHost.get(spec.host) ?? { worktrees: [], terminals: [] },
      ),
    ),
  ]);

  return mergeFleetReport(localHost, new Date().toISOString(), [localResult, ...remoteResults]);
}
