import { parseArgs, type FlagSpec } from "../args.js";
import { collectFleetAgents, type CollectFleetOptions } from "../agents/collect.js";
import { buildProjectSummaries } from "../agents/correlate.js";
import type { DocPresence, FleetAgentsReport } from "../agents/types.js";
import { collapseHome, helpBlock, toon } from "../render.js";

const AGENTS_FLAGS: FlagSpec[] = [
  { name: "--all-machines", description: "Probe remote fleet hosts (adi1, adi2, macmini, adi4) via SSH in parallel" },
  { name: "--project", value: "name", description: "Filter discovered agents and summaries by project substring" },
  { name: "--active-only", description: "Only show working or bridged agents (exclude idle)" },
  { name: "--summary-by-project", description: "Group output by project with Linear issues, worktrees, and doc presence" },
  { name: "--json", description: "Emit machine-readable JSON" },
];

export const AGENTS_HELP = `usage: orca-axi agents [--all-machines] [--project <name>] [--active-only] [--summary-by-project] [--json]
description:
  Discover all running coding agents (claude, codex, agy, grok, opencode,
  cursor, gemini, cline, hermes) on this machine and optionally across all
  fleet machines (adi0, adi1, adi2, macmini, adi4). Correlates OS PIDs/CWDs
  with Antigravity brain locks, Orca worktrees/terminals, Herdr sessions,
  tmux panes, git branches, Linear issues, and project docs.
outputs:
  TOON summary: totals, machines[], items[] (or projects[] with --summary-by-project)
  --json  machine-readable {agents: ...} envelope
flags[${AGENTS_FLAGS.length + 1}]:
${AGENTS_FLAGS.map((f) => `  ${f.name}${f.value ? ` <${f.value}>` : ""}`).join(", ")}, --help
examples:
  orca-axi agents
  orca-axi agents --all-machines --json
  orca-axi agents --all-machines --summary-by-project
  orca-axi agents --project firstmate --active-only
`;

export interface AgentsCommandDeps {
  collect?: (options: CollectFleetOptions) => Promise<FleetAgentsReport>;
}

export async function agentsCommand(
  args: string[],
  deps: AgentsCommandDeps = {},
): Promise<string> {
  if (args.includes("--help") || args.includes("-h")) {
    return AGENTS_HELP;
  }

  const { booleans, values } = parseArgs("agents", args, AGENTS_FLAGS);
  const allMachines = booleans.has("--all-machines");
  const activeOnly = booleans.has("--active-only");
  const summaryByProject = booleans.has("--summary-by-project");
  const json = booleans.has("--json");
  const projectFilter = values.get("--project")?.trim().toLowerCase() ?? null;

  const rawReport = await (deps.collect ?? collectFleetAgents)({ allMachines });

  const filteredItems = rawReport.items.filter((agent) => {
    if (activeOnly && agent.state === "idle") return false;
    if (projectFilter && !agent.project.toLowerCase().includes(projectFilter)) return false;
    return true;
  });

  const docsMap = new Map<string, DocPresence>();
  for (const proj of rawReport.projects) {
    docsMap.set(proj.project, proj.docs);
  }
  const filteredProjects = buildProjectSummaries(filteredItems, docsMap);

  const harnesses: Record<string, number> = {};
  for (const item of filteredItems) {
    harnesses[item.harness] = (harnesses[item.harness] ?? 0) + 1;
  }

  const envelope: FleetAgentsReport = {
    generatedAt: rawReport.generatedAt,
    localHost: rawReport.localHost,
    machines: rawReport.machines,
    totals: {
      agents: filteredItems.length,
      working: filteredItems.filter((a) => a.state === "working").length,
      idle: filteredItems.filter((a) => a.state === "idle").length,
      bridged: filteredItems.filter((a) => a.state === "bridged").length,
      machinesOnline: rawReport.totals.machinesOnline,
      machinesTotal: rawReport.totals.machinesTotal,
      activeProjects: filteredProjects.length,
      harnesses,
    },
    items: filteredItems,
    projects: filteredProjects,
  };

  if (json) {
    return JSON.stringify({ agents: envelope }, null, 2);
  }

  const compactView = summaryByProject
    ? {
        agents: {
          localHost: envelope.localHost,
          totals: envelope.totals,
          machines: envelope.machines,
          projects: envelope.projects.map((p) => ({
            project: p.project,
            activeAgents: p.activeAgentCount,
            working: p.workingCount,
            hosts: p.hosts.join(","),
            harnesses: p.harnesses.join(","),
            ...(p.linearIssues.length > 0 ? { linearIssues: p.linearIssues.join(",") } : {}),
            docs: `readme=${p.docs.readme},roadmap=${p.docs.roadmap},plans=${p.docs.plans}`,
          })),
        },
      }
    : {
        agents: {
          localHost: envelope.localHost,
          totals: envelope.totals,
          machines: envelope.machines,
          items: envelope.items.map((a) => ({
            host: a.host,
            pid: a.pid,
            harness: a.harness,
            state: a.state,
            surfaces: a.surfaces.join("+"),
            project: a.project,
            ...(a.branch ? { branch: a.branch } : {}),
            ...(a.linearIssue ? { linearIssue: a.linearIssue } : {}),
            ...(a.sessionId ? { session: a.sessionId.slice(0, 8) } : {}),
            ...(a.cwd ? { cwd: collapseHome(a.cwd) } : {}),
            title: a.title,
          })),
        },
      };

  const nextSteps = [
    allMachines
      ? "Run `orca-axi agents --all-machines --summary-by-project` to group by project"
      : "Run `orca-axi agents --all-machines` to include adi1, adi2, macmini, and adi4",
    "Run `orca-axi agents --all-machines --json` for the full machine-readable radar",
  ];

  return toon(compactView, helpBlock(nextSteps));
}
