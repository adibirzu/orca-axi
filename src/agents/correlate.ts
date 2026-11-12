import {
  extractLinearIssue,
  inferProjectFromPath,
  parseBridgeProcessLine,
  parsePsOutput,
  type BridgeProcessInfo,
} from "./classify.js";
import type {
  AgentActivityState,
  AgentHarness,
  AgentSurface,
  DiscoveredAgent,
  DocPresence,
  FleetAgentsReport,
  HostScanResult,
  ProjectSummary,
} from "./types.js";

export interface OrcaWorktreeSnapshot {
  readonly id: string;
  readonly path: string;
  readonly projectId?: string | null;
  readonly branch?: string | null;
  readonly linkedLinearIssue?: string | null;
  readonly lastActivityAt?: number | null;
}

export interface OrcaTerminalSnapshot {
  readonly handle: string;
  readonly worktreePath?: string | null;
  readonly title?: string | null;
  readonly lastOutputAt?: number | null;
}

export interface HerdrAgentSnapshot {
  readonly session: string;
  readonly agent: string;
  readonly agentStatus: string;
  readonly cwd: string | null;
  readonly paneId: string;
  readonly workspaceId: string;
  readonly workspaceLabel?: string | null;
  readonly sessionId?: string | null;
  readonly title?: string | null;
}

export interface TmuxPaneSnapshot {
  readonly paneRef: string;
  readonly panePid: number;
  readonly paneTty: string | null;
  readonly panePath: string | null;
  readonly windowName: string | null;
}

export interface GitDirInfo {
  readonly repoPath: string | null;
  readonly branch: string | null;
  readonly docs: DocPresence;
}

export interface CorrelateHostInput {
  readonly host: string;
  readonly nowMs?: number;
  readonly psText: string;
  readonly cwdsByPid: ReadonlyMap<number, string>;
  readonly agyLocksByPid?: ReadonlyMap<number, string>;
  readonly agyTranscriptMtimeByConv?: ReadonlyMap<string, number>;
  readonly orcaWorktrees?: readonly OrcaWorktreeSnapshot[];
  readonly orcaTerminals?: readonly OrcaTerminalSnapshot[];
  readonly herdrAgents?: readonly HerdrAgentSnapshot[];
  readonly tmuxPanes?: readonly TmuxPaneSnapshot[];
  readonly gitInfoByDir?: ReadonlyMap<string, GitDirInfo>;
}

const DEFAULT_DOCS: DocPresence = { readme: false, roadmap: false, plans: false };

function stripHeadsPrefix(branch: string | null | undefined): string | null {
  if (!branch) return null;
  return branch.replace(/^refs\/heads\//, "");
}

function findLongestWorktreeMatch(
  cwd: string | null,
  worktrees: readonly OrcaWorktreeSnapshot[],
): OrcaWorktreeSnapshot | undefined {
  if (!cwd) return undefined;
  let best: OrcaWorktreeSnapshot | undefined;
  for (const wt of worktrees) {
    if (cwd === wt.path || cwd.startsWith(`${wt.path}/`)) {
      if (!best || wt.path.length > best.path.length) {
        best = wt;
      }
    }
  }
  return best;
}

function primarySurface(surfaces: readonly AgentSurface[]): AgentSurface {
  if (surfaces.includes("orca")) return "orca";
  if (surfaces.includes("herdr")) return "herdr";
  if (surfaces.includes("tmux")) return "tmux";
  return "terminal";
}

export function correlateHostAgents(input: CorrelateHostInput): DiscoveredAgent[] {
  const nowMs = input.nowMs ?? Date.now();
  const processes = parsePsOutput(input.psText);
  const bridges: BridgeProcessInfo[] = input.psText
    .split(/\r?\n/)
    .map((line) => parseBridgeProcessLine(line))
    .filter((b): b is BridgeProcessInfo => b !== null);

  const orcaWorktrees = input.orcaWorktrees ?? [];
  const orcaTerminals = input.orcaTerminals ?? [];
  const herdrAgents = input.herdrAgents ?? [];
  const tmuxPanes = input.tmuxPanes ?? [];
  const agyLocksByPid = input.agyLocksByPid ?? new Map<number, string>();
  const agyMtimes = input.agyTranscriptMtimeByConv ?? new Map<string, number>();
  const gitInfoByDir = input.gitInfoByDir ?? new Map<string, GitDirInfo>();

  const matchedHerdrKeys = new Set<string>();

  const discovered: DiscoveredAgent[] = processes.map((proc) => {
    const rawCwd = input.cwdsByPid.get(proc.pid) ?? null;
    const lockedConv = agyLocksByPid.get(proc.pid) ?? null;
    const sessionId = proc.sessionId ?? lockedConv;
    const bridge = bridges.find(
      (b) => b.watchPid === proc.pid || (sessionId !== null && b.conversationId === sessionId),
    );

    // Match Herdr agent by sessionId first, else by cwd + harness, else bridged agy workspace
    const herdrMatch = herdrAgents.find(
      (ha) =>
        (sessionId !== null && ha.sessionId === sessionId) ||
        (rawCwd !== null && ha.cwd === rawCwd && ha.agent.toLowerCase() === proc.harness) ||
        (bridge !== undefined &&
          ha.agent.toLowerCase() === proc.harness &&
          Boolean(ha.workspaceLabel?.toLowerCase().includes("agy-captain"))),
    );
    if (herdrMatch) {
      matchedHerdrKeys.add(`${herdrMatch.session}:${herdrMatch.paneId}`);
    }

    const effectiveCwd = rawCwd ?? herdrMatch?.cwd ?? null;
    const matchedWt = findLongestWorktreeMatch(effectiveCwd, orcaWorktrees);
    const gitInfo = effectiveCwd ? gitInfoByDir.get(effectiveCwd) : undefined;

    // Match tmux pane via proc tty or bridge tty
    const tmuxMatch = tmuxPanes.find(
      (tp) =>
        (proc.tty !== null && tp.paneTty === proc.tty) ||
        tp.panePid === proc.pid ||
        (bridge !== undefined &&
          ((bridge.bridgeTty !== null && tp.paneTty === bridge.bridgeTty) ||
            tp.panePid === bridge.bridgePid)),
    );

    // Match Orca terminal by worktree path or session id fragment in title
    const shortConv = sessionId ? sessionId.slice(0, 8) : null;
    const orcaTermMatch = orcaTerminals.find(
      (ot) =>
        (shortConv !== null && ot.title?.includes(shortConv)) ||
        (matchedWt !== undefined && ot.worktreePath === matchedWt.path),
    );

    const surfaceSet = new Set<AgentSurface>();
    if (proc.tty) surfaceSet.add("terminal");
    if (tmuxMatch || bridge) surfaceSet.add("tmux");
    if (herdrMatch) surfaceSet.add("herdr");
    if (orcaTermMatch || matchedWt) surfaceSet.add("orca");
    if (surfaceSet.size === 0) surfaceSet.add("terminal");
    const surfaces = Array.from(surfaceSet);

    const agyLastMs = sessionId ? agyMtimes.get(sessionId) ?? null : null;
    const lastActivityAt =
      agyLastMs ??
      orcaTermMatch?.lastOutputAt ??
      matchedWt?.lastActivityAt ??
      (proc.cpuPercent > 0.2 ? nowMs : null);

    let state: AgentActivityState = "idle";
    if (bridge) {
      state = "bridged";
    } else if (herdrMatch?.agentStatus === "working") {
      state = "working";
    } else if (herdrMatch?.agentStatus === "idle" || herdrMatch?.agentStatus === "done") {
      state = proc.cpuPercent >= 1.0 ? "working" : "idle";
    } else if (
      proc.stat.includes("R") ||
      proc.cpuPercent >= 0.5 ||
      (agyLastMs !== null && nowMs - agyLastMs < 120_000) ||
      proc.harness === "hermes" ||
      proc.harness === "grok"
    ) {
      state = "working";
    }

    const branch =
      stripHeadsPrefix(gitInfo?.branch) ?? stripHeadsPrefix(matchedWt?.branch) ?? null;
    const repoPath = gitInfo?.repoPath ?? matchedWt?.path ?? effectiveCwd;
    const project = inferProjectFromPath(repoPath ?? effectiveCwd, matchedWt?.projectId);
    const linearIssue = extractLinearIssue(matchedWt?.linkedLinearIssue, branch);

    const titleParts = [
      herdrMatch?.workspaceLabel,
      orcaTermMatch?.title ?? herdrMatch?.title,
    ].filter((part): part is string => Boolean(part && part.trim()));
    const title =
      titleParts.length > 0
        ? Array.from(new Set(titleParts)).join(" · ")
        : sessionId
          ? `${proc.harness} (${sessionId.slice(0, 8)})`
          : proc.harness;

    return {
      id: `${input.host}:${proc.pid}`,
      host: input.host,
      pid: proc.pid,
      ppid: proc.ppid,
      tty: proc.tty,
      harness: proc.harness,
      surface: primarySurface(surfaces),
      surfaces,
      state,
      cpuPercent: proc.cpuPercent,
      elapsed: proc.elapsed || null,
      sessionId: sessionId ?? herdrMatch?.sessionId ?? null,
      title,
      cwd: effectiveCwd,
      project,
      repoPath: repoPath ?? null,
      worktreePath: matchedWt?.path ?? effectiveCwd,
      branch,
      linearIssue,
      lastActivityAt,
      command: proc.command,
    };
  });

  // Deduplicate parent/child shells of the exact same harness & session on the same TTY
  const byKey = new Map<string, DiscoveredAgent>();
  for (const agent of discovered) {
    const dedupKey =
      agent.sessionId !== null
        ? `${agent.host}:${agent.harness}:session:${agent.sessionId}`
        : `${agent.host}:${agent.harness}:pid:${agent.pid}`;
    const prev = byKey.get(dedupKey);
    if (!prev || agent.surfaces.length > prev.surfaces.length || agent.cpuPercent > prev.cpuPercent) {
      byKey.set(dedupKey, agent);
    }
  }

  return Array.from(byKey.values());
}

export function buildProjectSummaries(
  agents: readonly DiscoveredAgent[],
  docsByProject: ReadonlyMap<string, DocPresence> = new Map(),
): ProjectSummary[] {
  const groups = new Map<string, DiscoveredAgent[]>();
  for (const agent of agents) {
    const list = groups.get(agent.project) ?? [];
    groups.set(agent.project, [...list, agent]);
  }

  const summaries: ProjectSummary[] = [];
  for (const [project, items] of groups.entries()) {
    const workingCount = items.filter((a) => a.state === "working" || a.state === "bridged").length;
    const hosts = Array.from(new Set(items.map((a) => a.host))).sort();
    const harnesses = Array.from(new Set(items.map((a) => a.harness))).sort() as AgentHarness[];
    const linearIssues = Array.from(
      new Set(items.map((a) => a.linearIssue).filter((x): x is string => x !== null)),
    ).sort();
    const worktrees = Array.from(
      new Set(items.map((a) => a.worktreePath).filter((x): x is string => x !== null)),
    ).sort();
    const repoPath = items.find((a) => a.repoPath !== null)?.repoPath ?? null;
    const docs = docsByProject.get(project) ?? DEFAULT_DOCS;

    summaries.push({
      project,
      repoPath,
      activeAgentCount: items.length,
      workingCount,
      hosts,
      harnesses,
      linearIssues,
      worktrees,
      docs,
      agents: items,
    });
  }

  return summaries.sort(
    (a, b) =>
      b.workingCount - a.workingCount ||
      b.activeAgentCount - a.activeAgentCount ||
      a.project.localeCompare(b.project),
  );
}

export function mergeFleetReport(
  localHost: string,
  generatedAt: string,
  hostResults: readonly HostScanResult[],
): FleetAgentsReport {
  const machines = hostResults.map((r) => r.status);
  const allAgents = hostResults.flatMap((r) => r.agents);
  const mergedDocs = new Map<string, DocPresence>();
  for (const res of hostResults) {
    for (const [proj, doc] of res.docsByProject.entries()) {
      const existing = mergedDocs.get(proj);
      mergedDocs.set(
        proj,
        existing
          ? {
              readme: existing.readme || doc.readme,
              roadmap: existing.roadmap || doc.roadmap,
              plans: existing.plans || doc.plans,
            }
          : doc,
      );
    }
  }

  const projects = buildProjectSummaries(allAgents, mergedDocs);
  const harnesses: Record<string, number> = {};
  for (const agent of allAgents) {
    harnesses[agent.harness] = (harnesses[agent.harness] ?? 0) + 1;
  }

  const working = allAgents.filter((a) => a.state === "working").length;
  const bridged = allAgents.filter((a) => a.state === "bridged").length;
  const idle = allAgents.filter((a) => a.state === "idle").length;

  return {
    generatedAt,
    localHost,
    machines,
    totals: {
      agents: allAgents.length,
      working,
      idle,
      bridged,
      machinesOnline: machines.filter((m) => m.reachable).length,
      machinesTotal: machines.length,
      activeProjects: projects.length,
      harnesses,
    },
    items: allAgents,
    projects,
  };
}
