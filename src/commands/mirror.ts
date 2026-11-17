/**
 * `mirror`: project Firstmate fleet state into Orca UI cards (read-only).
 *
 * Source (decoupled, never a patch to the firstmate repo):
 * - `--from <path>`: read an `fm-fleet-snapshot.v1` JSON file (a captured
 *   `fm-fleet-snapshot.sh --json` document, or a test fixture). This is the
 *   documented file interface and the preferred seam for tests and the Mac.
 * - otherwise: run the documented Firstmate CLI
 *   (`$FM_FLEET_SNAPSHOT_BIN`, else `fm-fleet-snapshot.sh` on PATH) with the
 *   read-only `--json` flag and project its stdout. No other Firstmate
 *   command is ever invoked, and no Orca mutating command
 *   (`project setup-*`, `terminal *`, `orchestration *`, ...) is ever
 *   invoked either: the only effect beyond rendering is that read-only
 *   observation.
 *
 * Exit codes follow the AXI contract: 0 renders a view (even an empty
 * fleet), 1 is an unexpected failure, 2 is a usage error (unknown flag,
 * missing/unreadable/unparseable source).
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { AxiError } from "axi-sdk-js";

import { parseArgs, type FlagSpec } from "../args.js";
import { projectSnapshotToMirror } from "../mirror.js";
import { helpBlock, toon } from "../render.js";

const MIRROR_FLAGS: FlagSpec[] = [
  { name: "--from", value: "path", description: "Read the fm-fleet-snapshot.v1 JSON from <path>" },
  { name: "--json", description: "Emit the mirror view as JSON" },
  { name: "--full", description: "Include per-card detail (kind, links, blockers, holds)" },
];

/** Test/diagnostic hook: full snapshot-CLI override (path to executable). */
export const FLEET_SNAPSHOT_BIN_ENV = "FM_FLEET_SNAPSHOT_BIN";

export const MIRROR_HELP = `usage: orca-axi mirror [--from <path>] [--json] [--full]
description:
  Project Firstmate fleet state (task states, in-flight work, PR links)
  into Orca UI cards as a read-only view. Source is the documented
  Firstmate snapshot interface, never Firstmate tracked code: --from
  reads a captured fm-fleet-snapshot.sh --json file, otherwise the
  snapshot CLI ($FM_FLEET_SNAPSHOT_BIN or fm-fleet-snapshot.sh on PATH)
  is run with the read-only --json flag. Each card carries its Orca
  placement (project/host/environment per orca-ide --help) as a render
  hint. This is a projection, not a control plane: cards are readOnly
  with no controls, nothing here mutates Firstmate state, and nothing
  here invokes an Orca mutating command. Orca-runtime rendering is
  verified separately on the Mac where the desktop UI runs.
outputs:
  TOON view: source, summary{total,inFlight,queued,done}, cards[]
  --full  adds per-card detail{kind,since,links,blockedBy,holds}
  --json  the same view as JSON (cards also pass the Orca sink shape)
flags[${MIRROR_FLAGS.length + 1}]:
${MIRROR_FLAGS.map((flag) => `  ${flag.name}`).join(", ")}, --help
examples:
  orca-axi mirror --from snapshot.json
  orca-axi mirror --from snapshot.json --json
  orca-axi mirror --from snapshot.json --full
`;

export interface MirrorDeps {
  /** Test seam: canned snapshot document instead of reading the source. */
  loadSnapshot?: () => unknown;
  /** Test seam: file reader for --from. */
  readFile?: (path: string) => string;
  /** Test seam: snapshot-CLI runner for the default (no --from) path. */
  runSnapshotBin?: (bin: string) => string;
  env?: NodeJS.ProcessEnv;
}

function defaultRunSnapshotBin(bin: string): string {
  return execFileSync(bin, ["--json"], {
    encoding: "utf8",
    timeout: 15000,
    stdio: ["ignore", "pipe", "pipe"],
  }) as string;
}

function resolveSnapshotBin(env: NodeJS.ProcessEnv): string {
  const override = env[FLEET_SNAPSHOT_BIN_ENV]?.trim();
  if (override) return override;
  return "fm-fleet-snapshot.sh";
}

export async function mirrorCommand(args: string[], deps: MirrorDeps = {}): Promise<string> {
  if (args.includes("--help") || args.includes("-h")) {
    return MIRROR_HELP;
  }
  const { values, booleans } = parseArgs("mirror", args, MIRROR_FLAGS);
  const full = booleans.has("--full");
  const json = booleans.has("--json");
  const from = values.get("--from");

  let snapshot: unknown;
  if (deps.loadSnapshot) {
    snapshot = deps.loadSnapshot();
  } else if (from !== undefined) {
    snapshot = readSnapshotFile(from, deps.readFile ?? defaultReadFile);
  } else {
    snapshot = readSnapshotBin(
      deps.env ?? process.env,
      deps.runSnapshotBin ?? defaultRunSnapshotBin,
    );
  }

  const view = projectSnapshotToMirror(snapshot, full);

  if (json) {
    return JSON.stringify({ mirror: view }, null, 2);
  }
  const help = helpBlock([
    "Cards are read-only: nothing here mutates Firstmate or Orca state",
    "Run `orca-axi mirror --from snapshot.json --json` for the machine-readable view",
    "Run `orca-axi mirror --from snapshot.json --full` for per-card detail",
  ]);
  return toon({ mirror: view }, help);
}

function defaultReadFile(path: string): string {
  return readFileSync(path, "utf8");
}

function readSnapshotFile(path: string, readFile: (path: string) => string): unknown {
  let raw: string;
  try {
    raw = readFile(path);
  } catch {
    throw new AxiError(`cannot read snapshot file ${path}`, "VALIDATION_ERROR", [
      "Check the path exists and is readable",
      "Or capture one: fm-fleet-snapshot.sh --json > snapshot.json",
    ]);
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new AxiError(`snapshot file ${path} is not valid JSON`, "VALIDATION_ERROR", [
      "The source must be fm-fleet-snapshot.sh --json output",
      "Re-capture the snapshot and retry",
    ]);
  }
}

function readSnapshotBin(
  env: NodeJS.ProcessEnv,
  runSnapshotBin: (bin: string) => string,
): unknown {
  const bin = resolveSnapshotBin(env);
  let raw: string;
  try {
    raw = runSnapshotBin(bin);
  } catch {
    throw new AxiError(
      `cannot run the Firstmate snapshot CLI (${bin} --json)`,
      "VALIDATION_ERROR",
      [
        "Pass a captured file instead: orca-axi mirror --from <snapshot.json>",
        `Or set ${FLEET_SNAPSHOT_BIN_ENV} to the snapshot executable`,
      ],
    );
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new AxiError(`snapshot CLI ${bin} did not emit valid JSON`, "VALIDATION_ERROR", [
      "Pass a captured file instead: orca-axi mirror --from <snapshot.json>",
    ]);
  }
}
