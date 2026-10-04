import { runAxiCli } from "axi-sdk-js";

import { doctorCommand, DOCTOR_HELP } from "./commands/doctor.js";
import { fleetCommand, FLEET_HELP } from "./commands/fleet.js";
import { VERSION } from "./version.js";

export const DESCRIPTION =
  "Resolve and report the Orca terminal/session runtime binary.";

export const TOP_HELP = `usage: orca-axi [fleet|doctor] [flags]
commands[2]:
  (none)=fleet, doctor
output:
  Default TOON shows the smallest schema that lets the agent decide next.
  --full adds every candidate path, broken symlink, and session signal.
  --json is the machine escape hatch. update is built in:
  orca-axi update --check reports current vs latest without installing.
notes:
  orca is two programs sharing one name: the Orca terminal/session
  runtime (1.x, this tool's subject) and the GNOME screen reader on
  Linux desktops. orca-axi probes candidates with --version only and
  refuses (structured report, exit 0) rather than mis-invoke the reader.
flags[3]:
  --json, --full, --help, -v/--version
examples:
  orca-axi
  orca-axi fleet --json
  orca-axi doctor
  orca-axi doctor --full
  orca-axi update --check
`;

type MainOptions = {
  argv?: string[];
  stdout?: { write: (chunk: string) => unknown };
};

export async function main(options: MainOptions = {}): Promise<void> {
  const argv = normalizeArgv(options.argv ?? process.argv.slice(2));

  await runAxiCli({
    argv,
    description: DESCRIPTION,
    version: VERSION,
    topLevelHelp: TOP_HELP,
    ...(options.stdout ? { stdout: options.stdout } : {}),
    commands: {
      fleet: (args) => fleetCommand(args),
      doctor: (args) => doctorCommand(args),
    },
    // Bare `orca-axi` is the fleet dashboard (see normalizeArgv); wiring
    // home keeps the SDK contract for the empty-argv path too.
    home: (args) => fleetCommand(args),
    getCommandHelp: (command) => {
      if (command === "fleet") return FLEET_HELP;
      if (command === "doctor") return DOCTOR_HELP;
      return undefined;
    },
  });
}

/**
 * Route the flag-first default surface onto the `fleet` command.
 * `orca-axi`, `orca-axi --json`, and `orca-axi --full` all mean "show the
 * fleet view", but runAxiCli routes on argv[0] and rejects a leading flag.
 * Prefixing the implicit `fleet` command name preserves the bare-invocation
 * dashboard while letting the SDK own routing, help, version, update, and
 * error framing.
 */
export function normalizeArgv(raw: string[]): string[] {
  if (raw[0] === "--") raw = raw.slice(1);
  if (raw.length === 0) return ["fleet"];
  if (raw.length === 1 && (raw[0] === "--help" || isVersionFlag(raw[0]))) {
    return raw;
  }
  const first = raw[0] ?? "";
  if (first === "fleet" || first === "doctor" || first === "update") {
    return raw;
  }
  if (first.startsWith("-")) {
    return ["fleet", ...raw];
  }
  return raw;
}

function isVersionFlag(flag: string): boolean {
  return flag === "-v" || flag === "-V" || flag === "--version";
}
