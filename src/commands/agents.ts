import { AxiError } from "axi-sdk-js";

import { parseArgs, type FlagSpec } from "../args.js";
import { collectFleetAgents, type CollectFleetOptions } from "../agents/collect.js";
import { buildProjectSummaries } from "../agents/correlate.js";
import type {
  DiscoveredAgent,
  DocPresence,
  FleetAgentsReport,
  FleetAgentsTotals,
  MachineScanStatus,
  ProjectSummary,
} from "../agents/types.js";
import {
  loadPortfolioCatalog,
  lookupRepoCatalogEntry,
  normalizeTierFilter,
  type CatalogLoadResult,
  type CatalogLoadStatus,
  type LoadCatalogOptions,
  type PortfolioTier,
} from "../portfolio/catalog.js";
import { collapseHome, helpBlock, toon } from "../render.js";

const AGENTS_FLAGS: FlagSpec[] = [
  { name: "--all-machines", description: "Probe remote fleet hosts (adi1, adi2, macmini, adi4) via SSH in parallel" },
  { name: "--project", value: "name", description: "Filter discovered agents and summaries by project substring" },
  { name: "--active-only", description: "Only show working or bridged agents (exclude idle)" },
  { name: "--summary-by-project", description: "Group output by project with Linear issues, worktrees, and doc presence" },
  { name: "--by-domain", description: "Group project summaries by portfolio domain from ~/.config/orca-axi/portfolio-catalog.json" },
  { name: "--tier", value: "tier", description: "Filter agents and project summaries by portfolio tier (1|2|3)" },
  { name: "--json", description: "Emit machine-readable JSON" },
];

export const AGENTS_HELP = `usage: orca-axi agents [--all-machines] [--project <name>] [--active-only] [--summary-by-project] [--by-domain] [--tier <tier>] [--json]
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
  orca-axi projects --by-domain --tier 1
  orca-axi agents --project firstmate --active-only
`;

export interface EnrichedProjectSummary extends ProjectSummary {
  readonly domain: string;
  readonly tier: PortfolioTier | null;
  readonly linearProjectId: string | null;
}

export interface DomainProjectGroup {
  readonly domain: string;
  readonly activeProjects: number;
  readonly activeAgents: number;
  readonly working: number;
  readonly projectNames: readonly string[];
}

export interface EnrichedFleetAgentsReport {
  readonly generatedAt: string;
  readonly localHost: string;
  readonly catalogStatus?: CatalogLoadStatus;
  readonly machines: readonly MachineScanStatus[];
  readonly totals: FleetAgentsTotals;
  readonly items: readonly DiscoveredAgent[];
  readonly projects: readonly (ProjectSummary | EnrichedProjectSummary)[];
  readonly domains?: readonly DomainProjectGroup[];
}

export interface AgentsCommandDeps {
  collect?: (options: CollectFleetOptions) => Promise<FleetAgentsReport>;
  loadCatalog?: (options?: LoadCatalogOptions) => CatalogLoadResult;
}

export async function agentsCommand(
  args: string[],
  deps: AgentsCommandDeps = {},
): Promise<string> {
  if (args[0] === "--help" || args[0] === "-h") {
    return AGENTS_HELP;
  }

  const { booleans, values } = parseArgs("agents", args, AGENTS_FLAGS);
  const allMachines = booleans.has("--all-machines");
  const activeOnly = booleans.has("--active-only");
  const byDomain = booleans.has("--by-domain");
  const rawTier = values.get("--tier");
  const normalizedTier = normalizeTierFilter(rawTier);
  if (rawTier !== undefined && normalizedTier === null) {
    throw new AxiError(`invalid --tier value "${rawTier}"`, "VALIDATION_ERROR", [
      "Valid --tier values: 1, 2, 3, tier-1-primary, tier-2-active, tier-3-reference",
    ]);
  }
  const useCatalog = byDomain || normalizedTier !== null;
  const summaryByProject = booleans.has("--summary-by-project") || useCatalog;
  const json = booleans.has("--json");
  const projectFilter = values.get("--project")?.trim().toLowerCase() ?? null;

  const catalogResult = useCatalog
    ? (deps.loadCatalog ?? loadPortfolioCatalog)()
    : null;
  const catalog = catalogResult?.catalog ?? null;

  const rawReport = await (deps.collect ?? collectFleetAgents)({ allMachines });

  const preFilteredItems = rawReport.items.filter((agent) => {
    if (activeOnly && agent.state === "idle") return false;
    if (projectFilter && !agent.project.toLowerCase().includes(projectFilter)) return false;
    return true;
  });

  const docsMap = new Map<string, DocPresence>();
  for (const proj of rawReport.projects) {
    docsMap.set(proj.project, proj.docs);
  }
  const baseProjects = buildProjectSummaries(preFilteredItems, docsMap);

  const enrichedProjects: EnrichedProjectSummary[] = baseProjects
    .map((proj) => {
      const entry = lookupRepoCatalogEntry(catalog, proj.project, proj.repoPath);
      return {
        ...proj,
        domain: entry?.domain ?? "unclassified",
        tier: entry?.tier ?? null,
        linearProjectId: entry?.linear_project_id ?? null,
      };
    })
    .filter((proj) =>
      normalizedTier && catalog !== null ? proj.tier === normalizedTier : true,
    );

  const allowedProjectNames = new Set(enrichedProjects.map((p) => p.project));
  const filteredItems =
    normalizedTier && catalog !== null
      ? preFilteredItems.filter((item) => allowedProjectNames.has(item.project))
      : preFilteredItems;

  const harnesses: Record<string, number> = {};
  for (const item of filteredItems) {
    harnesses[item.harness] = (harnesses[item.harness] ?? 0) + 1;
  }

  let domainGroups: DomainProjectGroup[] | undefined;
  if (byDomain) {
    const byDomMap = new Map<string, EnrichedProjectSummary[]>();
    for (const proj of enrichedProjects) {
      const existing = byDomMap.get(proj.domain);
      if (existing) {
        existing.push(proj);
      } else {
        byDomMap.set(proj.domain, [proj]);
      }
    }
    domainGroups = Array.from(byDomMap.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([domain, projs]) => ({
        domain,
        activeProjects: projs.length,
        activeAgents: projs.reduce((sum, p) => sum + p.activeAgentCount, 0),
        working: projs.reduce((sum, p) => sum + p.workingCount, 0),
        projectNames: projs.map((p) => p.project),
      }));
  }

  const envelope: EnrichedFleetAgentsReport = {
    generatedAt: rawReport.generatedAt,
    localHost: rawReport.localHost,
    ...(catalogResult ? { catalogStatus: catalogResult.status } : {}),
    machines: rawReport.machines,
    totals: {
      agents: filteredItems.length,
      working: filteredItems.filter((a) => a.state === "working").length,
      idle: filteredItems.filter((a) => a.state === "idle").length,
      bridged: filteredItems.filter((a) => a.state === "bridged").length,
      machinesOnline: rawReport.totals.machinesOnline,
      machinesTotal: rawReport.totals.machinesTotal,
      activeProjects: useCatalog ? enrichedProjects.length : baseProjects.length,
      harnesses,
    },
    items: filteredItems,
    projects: useCatalog ? enrichedProjects : baseProjects,
    ...(domainGroups ? { domains: domainGroups } : {}),
  };

  if (json) {
    return JSON.stringify({ agents: envelope }, null, 2);
  }

  const compactView = summaryByProject
    ? {
        agents: {
          localHost: envelope.localHost,
          ...(catalogResult ? { catalogStatus: catalogResult.status } : {}),
          totals: envelope.totals,
          machines: envelope.machines,
          ...(domainGroups
            ? {
                domains: domainGroups.map((dg) => ({
                  domain: dg.domain,
                  activeProjects: dg.activeProjects,
                  activeAgents: dg.activeAgents,
                  working: dg.working,
                  projects: dg.projectNames.join(","),
                })),
              }
            : {}),
          projects: enrichedProjects.map((p) => ({
            project: p.project,
            ...(useCatalog ? { domain: p.domain, tier: p.tier ?? "-" } : {}),
            activeAgents: p.activeAgentCount,
            working: p.workingCount,
            hosts: p.hosts.join(","),
            harnesses: p.harnesses.join(","),
            linearIssues: p.linearIssues.length > 0 ? p.linearIssues.join(",") : "-",
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
            branch: a.branch ?? "-",
            linearIssue: a.linearIssue ?? "-",
            session: a.sessionId ? a.sessionId.slice(0, 8) : "-",
            cwd: a.cwd ? collapseHome(a.cwd) : "-",
            title: a.title,
          })),
        },
      };

  const nextSteps = [
    ...(catalogResult && catalogResult.status !== "ok"
      ? [
          `Portfolio catalog status=${catalogResult.status} at ${collapseHome(catalogResult.catalogPath)}; create it to enable domain/tier classification`,
        ]
      : []),
    allMachines
      ? "Run `orca-axi projects --all-machines --by-domain` to group active projects by portfolio domain"
      : "Run `orca-axi agents --all-machines` to include adi1, adi2, macmini, and adi4",
    "Run `orca-axi portfolio` to inspect the full workstation repository & Linear initiative catalog",
  ];

  return toon(compactView, helpBlock(nextSteps));
}
