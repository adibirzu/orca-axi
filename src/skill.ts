import { DESCRIPTION, TOP_HELP } from "./cli.js";
import { DOCTOR_HELP } from "./commands/doctor.js";
import { FLEET_HELP } from "./commands/fleet.js";
import { VERSION } from "./version.js";

/**
 * Single source of truth for `skills/orca-axi/SKILL.md`: generated from
 * the same help text the CLI prints, minus live state (a skill is static).
 * `npm run build:skill -- --check` fails when the committed file is stale.
 */
export function createSkillMarkdown(): string {
  return `---
name: orca-axi
description: >
  Resolve and report the Orca terminal/session runtime binary: which orca
  is on PATH, runtime vs GNOME screen-reader identity, and the Linux
  accessibility guard. Use when checking Orca availability, debugging a
  broken orca shim, or choosing the binary a session should invoke.
---

# orca-axi

${DESCRIPTION} Version ${VERSION}.

Status: **OB-3 scaffold.** \`fleet\` (the no-arg dashboard) and \`doctor\`
are live. \`update\`/\`update --check\` are built in via axi-sdk-js.

Run it without a global install:

\`\`\`sh
npx -y orca-axi
npx -y orca-axi doctor
\`\`\`

## Why this tool exists

\`orca\` is two unrelated programs sharing one name: the Orca
terminal/session runtime (1.x, this tool's subject) and the GNOME screen
reader that ships as \`/usr/bin/orca\` on most Linux desktops. orca-axi
probes every candidate with \`--version\` only, tells the two apart, and
refuses with a structured report (exit 0) rather than mis-invoke the
screen reader for terminal control. \`ORCA_CLI_COMMAND\` overrides the
search when set.

## Commands

\`\`\`sh
npx -y orca-axi                       # fleet view (same as: orca-axi fleet)
npx -y orca-axi fleet --json
npx -y orca-axi doctor                # binary diagnosis
npx -y orca-axi doctor --full          # every candidate path tried
npx -y orca-axi doctor --json
npx -y orca-axi update --check        # current vs latest, no install
\`\`\`

Top-level surface:

\`\`\`
${TOP_HELP}\`\`\`

\`fleet\` contract:

\`\`\`
${FLEET_HELP}\`\`\`

\`doctor\` contract:

\`\`\`
${DOCTOR_HELP}\`\`\`

## Exit codes

\`\`\`
0  success (including idempotent no-ops and doctor diagnostics)
1  error: unexpected failure
2  usage error: unknown flag, unknown command, bad update option
\`\`\`

Default stdout is TOON; \`--json\` is the machine escape hatch.
`;
}
