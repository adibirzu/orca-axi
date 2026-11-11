export type AgentHarness =
  | "claude"
  | "codex"
  | "agy"
  | "grok"
  | "opencode"
  | "cursor"
  | "gemini"
  | "cline"
  | "hermes";

export type AgentSurface = "orca" | "herdr" | "tmux" | "terminal";

export type AgentActivityState = "working" | "idle" | "bridged";

export interface DocPresence {
  readonly readme: boolean;
  readonly roadmap: boolean;
  readonly plans: boolean;
}

export interface DiscoveredAgent {
  readonly id: string;
  readonly host: string;
  readonly pid: number | null;
  readonly ppid: number | null;
  readonly tty: string | null;
  readonly harness: AgentHarness;
  readonly surface: AgentSurface;
  readonly surfaces: readonly AgentSurface[];
  readonly state: AgentActivityState;
  readonly cpuPercent: number;
  readonly elapsed: string | null;
  readonly sessionId: string | null;
  readonly title: string | null;
  readonly cwd: string | null;
  readonly project: string;
  readonly repoPath: string | null;
  readonly worktreePath: string | null;
  readonly branch: string | null;
  readonly linearIssue: string | null;
  readonly lastActivityAt: number | null;
  readonly command: string;
}

export interface MachineScanStatus {
  readonly host: string;
  readonly reachable: boolean;
  readonly agentCount: number;
  readonly workingCount: number;
  readonly durationMs: number;
  readonly error?: string;
}

export interface ProjectSummary {
  readonly project: string;
  readonly repoPath: string | null;
  readonly activeAgentCount: number;
  readonly workingCount: number;
  readonly hosts: readonly string[];
  readonly harnesses: readonly AgentHarness[];
  readonly linearIssues: readonly string[];
  readonly worktrees: readonly string[];
  readonly docs: DocPresence;
  readonly agents: readonly DiscoveredAgent[];
}

export interface FleetAgentsTotals {
  readonly agents: number;
  readonly working: number;
  readonly idle: number;
  readonly bridged: number;
  readonly machinesOnline: number;
  readonly machinesTotal: number;
  readonly activeProjects: number;
  readonly harnesses: Readonly<Record<string, number>>;
}

export interface FleetAgentsReport {
  readonly generatedAt: string;
  readonly localHost: string;
  readonly machines: readonly MachineScanStatus[];
  readonly totals: FleetAgentsTotals;
  readonly items: readonly DiscoveredAgent[];
  readonly projects: readonly ProjectSummary[];
}

export interface HostScanResult {
  readonly status: MachineScanStatus;
  readonly agents: readonly DiscoveredAgent[];
  readonly docsByProject: ReadonlyMap<string, DocPresence>;
}
