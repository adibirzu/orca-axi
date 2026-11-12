import { DESCRIPTION, TOP_HELP } from "./cli.js";
import { AGENTS_HELP } from "./commands/agents.js";
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
  Resolve and report the Orca terminal/session runtime binary and discover
  working coding agents across local and remote fleet hosts, organized by
  project, git branch, Linear issue, and terminal surface (Orca, Herdr, tmux).
---

# orca-axi

${DESCRIPTION} Version ${VERSION}.

Status: **Live fleet & agent radar.** \`fleet\` (the no-arg dashboard),
\`agents\` / \`projects\`, and \`doctor\` are live. \`update\`/\`update --check\`
are built in via axi-sdk-js.

Run it without a global install:

\`\`\`sh
npx -y orca-axi
npx -y orca-axi agents --all-machines
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

In addition, \`orca-axi agents\` discovers every running coding agent
(\`claude\`, \`codex\`, \`agy\`, \`grok\`, \`opencode\`, \`cursor\`, \`gemini\`,
\`cline\`, \`hermes\`) locally and across SSH fleet machines, correlating OS
processes with Orca worktrees/terminals, Herdr sessions, tmux panes, git
branches, and Linear issues.

## Commands

\`\`\`sh
npx -y orca-axi                       # fleet view (same as: orca-axi fleet)
npx -y orca-axi fleet --json
npx -y orca-axi agents --all-machines # cross-machine agent radar
npx -y orca-axi projects --all-machines
npx -y orca-axi doctor                # binary diagnosis
npx -y orca-axi doctor --full         # every candidate path tried
npx -y orca-axi doctor --json
npx -y orca-axi update --check        # current vs latest, no install
\`\`\`

Top-level surface:

\`\`\`
${TOP_HELP}\`\`\`

\`fleet\` contract:

\`\`\`
${FLEET_HELP}\`\`\`

\`agents\` contract:

\`\`\`
${AGENTS_HELP}\`\`\`

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
