/**
 * `fleet`: the no-arg dashboard. One screen of live state — which Orca
 * binary this machine resolves to and whether it is usable — so an agent
 * can orient without a second call.
 */

import { resolveOrca, type OrcaResolution } from "../orca-resolve.js";
import { parseArgs, type FlagSpec } from "../args.js";
import { collapseHome, helpBlock, toon } from "../render.js";

const FLEET_FLAGS: FlagSpec[] = [
  { name: "--json", description: "Emit the fleet view as JSON" },
  { name: "--full", description: "Include every candidate path and session signal" },
];

export const FLEET_HELP = `usage: orca-axi [fleet] [--json] [--full]
description:
  Show the Orca fleet view: the resolved runtime binary, its version
  and identity, and the screen-reader guard state. Bare orca-axi runs
  this view. A refused status means the guard fired; see the reason and
  run orca-axi doctor for the full diagnosis.
outputs:
  TOON summary: status, binary{path,source,version,identity}, reason?
  --full  adds candidates tried, broken symlinks, and session signals
  --json  the same view as JSON
flags[${FLEET_FLAGS.length + 1}]:
${FLEET_FLAGS.map((flag) => `  ${flag.name}`).join(", ")}, --help
examples:
  orca-axi
  orca-axi fleet --json
  orca-axi doctor --full
`;

export interface FleetDeps {
  /** Test seam: canned resolution instead of probing the host. */
  resolve?: () => OrcaResolution;
}

export async function fleetCommand(args: string[], deps: FleetDeps = {}): Promise<string> {
  if (args.includes("--help") || args.includes("-h")) {
    return FLEET_HELP;
  }
  const { booleans } = parseArgs("fleet", args, FLEET_FLAGS);
  const full = booleans.has("--full");
  const json = booleans.has("--json");

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

  if (json) {
    return JSON.stringify({ fleet: view }, null, 2);
  }
  const help =
    resolution.status === "ok"
      ? helpBlock([
        "Run `orca-axi doctor` for the full binary diagnosis",
        "Run `orca-axi fleet --json` for the machine-readable view",
      ])
      : helpBlock([
        "Run `orca-axi doctor` for the full binary diagnosis",
        ...resolution.suggestions,
      ]);
  return toon({ fleet: view }, help);
}
