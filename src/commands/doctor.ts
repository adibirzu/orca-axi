/**
 * `doctor`: resolve and report the Orca terminal/session runtime binary.
 *
 * Doctor is a diagnostic, not a gate: it exits 0 in every case and never
 * executes the resolved binary for anything beyond a `--version` identity
 * probe. Callers branch on the reported `status` (`ok` | `refused` |
 * `error`), not the exit code. `refused` means the screen-reader guard
 * fired: what resolved is (or may be) the unrelated GNOME screen reader
 * that shares the `orca` name, and invoking it for terminal control would
 * be a mis-invocation.
 */

import { ORCA_CLI_COMMAND_ENV, resolveOrca, type OrcaResolution } from "../orca-resolve.js";
import { parseArgs, type FlagSpec } from "../args.js";
import { collapseHome, helpBlock, toon } from "../render.js";

const DOCTOR_FLAGS: FlagSpec[] = [
  { name: "--json", description: "Emit the check results as JSON" },
  { name: "--full", description: "Include every candidate path and session signal" },
];

export const DOCTOR_HELP = `usage: orca-axi doctor [--json] [--full]
description:
  Resolve and report the Orca terminal/session runtime binary. Probes
  each candidate with --version only, identifies the 1.x runtime versus
  the unrelated GNOME screen reader that shares the orca name, and
  refuses (structured report, exit 0) rather than mis-invoke it.
  ${ORCA_CLI_COMMAND_ENV} overrides the search. Doctor is a diagnostic,
  not a gate: it exits 0 in every case; branch on status, not the exit code.
checks[4]{name}:
  shim=~/.local/bin/orca resolves (dangling symlinks reported, not fatal)
  bundle=macOS .app Resources/bin or MacOS layout detected
  override=${ORCA_CLI_COMMAND_ENV} wins the search when set
  guard=Linux screen-reader/accessibility sessions refuse without explicit intent
outputs:
  TOON report: status, binary{path,source,version,identity}, reason?
  --full  adds candidates tried, broken symlinks, and session signals
  --json  the same report as JSON
flags[${DOCTOR_FLAGS.length + 1}]:
${DOCTOR_FLAGS.map((flag) => `  ${flag.name}`).join(", ")}, --help
examples:
  orca-axi doctor
  orca-axi doctor --full
  orca-axi doctor --json
`;

export interface DoctorDeps {
  /** Test seam: canned resolution instead of probing the host. */
  resolve?: () => OrcaResolution;
}

export async function doctorCommand(args: string[], deps: DoctorDeps = {}): Promise<string> {
  if (args.includes("--help") || args.includes("-h")) {
    return DOCTOR_HELP;
  }
  const { booleans } = parseArgs("doctor", args, DOCTOR_FLAGS);
  const full = booleans.has("--full");
  const json = booleans.has("--json");

  const resolution = (deps.resolve ?? resolveOrca)();
  const binary = resolution.binary
    ? {
        path: collapseHome(resolution.binary.path),
        source: resolution.binary.source,
        ...(resolution.binary.version ? { version: resolution.binary.version } : {}),
        identity: resolution.binary.identity,
        ...(full && resolution.binary.bundle ? { bundle: true } : {}),
      }
    : undefined;
  const report: Record<string, unknown> = {
    status: resolution.status,
    platform: resolution.platform,
    ...(binary ? { binary } : {}),
    ...(resolution.reason ? { reason: resolution.reason } : {}),
  };
  if (full) {
    report.candidates = {
      missing: resolution.missingCandidates.map((path) => collapseHome(path)),
      brokenSymlinks: resolution.brokenSymlinks.map((entry) => ({
        path: collapseHome(entry.path),
        ...(entry.target ? { target: entry.target } : {}),
      })),
    };
    report.session = {
      active: resolution.sessionActive,
      signals: resolution.sessionSignals,
    };
  } else if (resolution.sessionActive) {
    report.session = { active: true };
  }
  if (resolution.suggestions.length > 0 && (full || resolution.status !== "ok")) {
    report.suggestions = resolution.suggestions;
  }

  if (json) {
    return JSON.stringify(report, null, 2);
  }
  const help =
    resolution.status === "ok"
      ? helpBlock([
        "Run `orca-axi doctor --full` for every candidate path tried",
        "Run `orca-axi doctor --json` for the machine-readable report",
      ])
      : helpBlock(resolution.suggestions);
  return toon({ doctor: report }, help);
}
