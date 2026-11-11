import { AxiError } from "axi-sdk-js";

export interface FlagSpec {
  /** Canonical flag name, e.g. `--json`. */
  name: string;
  /** Value placeholder when the flag takes a value; omitted for booleans. */
  value?: string;
  description: string;
}

export interface ParsedArgs {
  values: Map<string, string>;
  booleans: Set<string>;
}

/**
 * Strict per-command flag parsing per the AXI "fail loud on unrecognized
 * input" rule: an unknown flag is refused by name with the command's valid
 * flags inlined, so the agent self-corrects in one turn. `--help` is handled
 * by the caller (or the SDK) before this runs.
 */
export function parseArgs(
  command: string,
  args: string[],
  specs: FlagSpec[],
): ParsedArgs {
  const byName = new Map(specs.map((spec) => [spec.name, spec]));
  const values = new Map<string, string>();
  const booleans = new Set<string>();

  for (let index = 0; index < args.length; index++) {
    const arg = args[index] ?? "";
    if (arg === "--") {
      continue;
    }

    let name = arg;
    let inlineValue: string | undefined;
    if (arg.startsWith("--") && arg.includes("=")) {
      const equals = arg.indexOf("=");
      name = arg.slice(0, equals);
      inlineValue = arg.slice(equals + 1);
    }

    const spec = byName.get(name);
    if (!spec) {
      throw new AxiError(`unknown flag ${name} for \`${command}\``, "VALIDATION_ERROR", [
        `valid flags for \`${command}\`: ${validFlags(specs)}`,
        `Run \`orca-axi ${command} --help\` for the contract`,
      ]);
    }

    if (spec.value !== undefined) {
      const value = inlineValue ?? args[++index];
      if (value === undefined || value.startsWith("--")) {
        throw new AxiError(
          `flag ${name} requires a value <${spec.value}>`,
          "VALIDATION_ERROR",
          [`Example: ${name} <${spec.value}>`, `Run \`orca-axi ${command} --help\``],
        );
      }
      values.set(name, value);
    } else {
      if (inlineValue !== undefined) {
        throw new AxiError(`flag ${name} takes no value`, "VALIDATION_ERROR", [
          `Remove the value after ${name}`,
        ]);
      }
      booleans.add(name);
    }
  }

  return { values, booleans };
}

export function validFlags(specs: FlagSpec[]): string {
  return specs.map((spec) => spec.name).join(", ");
}
