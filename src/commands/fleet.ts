/**
 * `fleet`: the no-arg dashboard. One screen of live state — which Orca
 * binary this machine resolves to, whether it is usable, and optionally live
 * working agents across the fleet — so an agent can orient without a second call.
 */

import { collectFleetAgents, type CollectFleetOptions } from "../agents/collect.js";
import type { FleetAgentsReport } from "../agents/types.js";
import { resolveOrca, type OrcaResolution } from "../orca-resolve.js";
import { parseArgs, type FlagSpec } from "../args.js";
import { collapseHome, helpBlock, toon } from "../render.js";

const FLEET_FLAGS: FlagSpec[] = [
  { name: "--json", description: "Emit the fleet view as JSON" },
  { name: "--full", description: "Include every candidate path and session signal" },
  { name: "--agents", description: "Include live working agents summary on this host" },
  { name: "--all-machines", description: "Include live working agents across all fleet hosts" },
];

export const FLEET_HELP = `usage: orca-axi [fleet] [--json] [--full] [--agents] [--all-machines]
description:
  Show the Orca fleet view: the resolved runtime binary, its version
  and identity, the screen-reader guard state, and optional live fleet
  agent discovery (--agents / --all-machines). Bare orca-axi runs this
  view. A refused status means the guard fired; see the reason and run
  orca-axi doctor for the full diagnosis.
outputs:
  TOON summary: status, binary{path,source,version,identity}, reason?, agentsSummary?
  --full          adds candidates tried, broken symlinks, and session signals
  --agents        adds local working agents & active projects summary
  --all-machines  probes adi0, adi1, adi2, macmini, adi4 for running agents
  --json          the same view as JSON
flags[${FLEET_FLAGS.length + 1}]:
${FLEET_FLAGS.map((flag) => `  ${flag.name}`).join(", ")}, --help
examples:
  orca-axi
  orca-axi fleet --json
  orca-axi fleet --all-machines --json
  orca-axi agents --all-machines
  orca-axi doctor --full
`;

export interface FleetDeps {
  /** Test seam: canned resolution instead of probing the host. */
  resolve?: () => OrcaResolution;
  /** Test seam: canned agent scan instead of probing OS/SSH. */
  collectAgents?: (options: CollectFleetOptions) => Promise<FleetAgentsReport>;
}

export async function fleetCommand(args: string[], deps: FleetDeps = {}): Promise<string> {
  if (args.includes("--help") || args.includes("-h")) {
    return FLEET_HELP;
  }
  const { booleans } = parseArgs("fleet", args, FLEET_FLAGS);
  const full = booleans.has("--full");
  const json = booleans.has("--json");
  const allMachines = booleans.has("--all-machines");
  const includeAgents = booleans.has("--agents") || allMachines;

  const resolution = (deps.resolve ?? resolveOrca)();
  const binary = resolution.binary
    ? {
        path: collapseHome(resolution.binary.path),
        source: resolution.binary.source,
        ...(resolution.binary.version ? { version: resolution.binary.version } : {}),
        identity: resolution.binary.identity,
      }
    : undefined;
  const view: Record<string, unknown> = {
    status: resolution.status,
    platform: resolution.platform,
    ...(binary ? { binary } : {}),
    ...(resolution.reason ? { reason: resolution.reason } : {}),
  };
  if (full) {
    view.candidates = {
      missing: resolution.missingCandidates.map((path) => collapseHome(path)),
      brokenSymlinks: resolution.brokenSymlinks.map((entry) => ({
        path: collapseHome(entry.path),
        ...(entry.target ? { target: entry.target } : {}),
      })),
    };
    view.session = {
      active: resolution.sessionActive,
      signals: resolution.sessionSignals,
    };
  }

  if (includeAgents) {
    const report = await (deps.collectAgents ?? collectFleetAgents)({ allMachines });
    view.agentsSummary = {
      total: report.totals.agents,
      working: report.totals.working,
      bridged: report.totals.bridged,
      idle: report.totals.idle,
      machinesOnline: report.totals.machinesOnline,
      machinesTotal: report.totals.machinesTotal,
      activeProjects: report.totals.activeProjects,
      harnesses: report.totals.harnesses,
    };
    view.projects = report.projects.map((p) => ({
      project: p.project,
      activeAgents: p.activeAgentCount,
      working: p.workingCount,
      hosts: p.hosts,
      harnesses: p.harnesses,
      linearIssues: p.linearIssues,
    }));
  }

  if (json) {
    return JSON.stringify({ fleet: view }, null, 2);
  }
  const help =
    resolution.status === "ok"
      ? helpBlock([
          "Run `orca-axi agents --all-machines` to inspect all working agents across the fleet",
          "Run `orca-axi doctor` for the full binary diagnosis",
          "Run `orca-axi fleet --json` for the machine-readable view",
        ])
      : helpBlock([
          "Run `orca-axi doctor` for the full binary diagnosis",
          ...resolution.suggestions,
        ]);
  return toon({ fleet: view }, help);
}
