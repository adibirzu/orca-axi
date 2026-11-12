---
name: orca-axi
description: >
  Resolve and report the Orca terminal/session runtime binary and discover
  working coding agents across local and remote fleet hosts, organized by
  project, git branch, Linear issue, and terminal surface (Orca, Herdr, tmux).
---

# orca-axi

Resolve the Orca runtime binary and discover working coding agents across your fleet. Version 0.1.0.

Status: **Live fleet & agent radar.** `fleet` (the no-arg dashboard),
`agents` / `projects`, and `doctor` are live. `update`/`update --check`
are built in via axi-sdk-js.

Run it without a global install:

```sh
npx -y orca-axi
npx -y orca-axi agents --all-machines
npx -y orca-axi doctor
```

## Why this tool exists

`orca` is two unrelated programs sharing one name: the Orca
terminal/session runtime (1.x, this tool's subject) and the GNOME screen
reader that ships as `/usr/bin/orca` on most Linux desktops. orca-axi
probes every candidate with `--version` only, tells the two apart, and
refuses with a structured report (exit 0) rather than mis-invoke the
screen reader for terminal control. `ORCA_CLI_COMMAND` overrides the
search when set.

In addition, `orca-axi agents` discovers every running coding agent
(`claude`, `codex`, `agy`, `grok`, `opencode`, `cursor`, `gemini`,
`cline`, `hermes`) locally and across SSH fleet machines, correlating OS
processes with Orca worktrees/terminals, Herdr sessions, tmux panes, git
branches, and Linear issues.

## Commands

```sh
npx -y orca-axi                       # fleet view (same as: orca-axi fleet)
npx -y orca-axi fleet --json
npx -y orca-axi agents --all-machines # cross-machine agent radar
npx -y orca-axi projects --all-machines
npx -y orca-axi doctor                # binary diagnosis
npx -y orca-axi doctor --full         # every candidate path tried
npx -y orca-axi doctor --json
npx -y orca-axi update --check        # current vs latest, no install
```

Top-level surface:

```
usage: orca-axi [fleet|agents|projects|doctor] [flags]
commands[4]:
  (none)=fleet, agents, projects, doctor
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
  agents discovers live coding agents (claude, codex, agy, grok, opencode,
  cursor, gemini, cline, hermes) across local and SSH fleet machines.
flags[5]:
  --json, --full, --all-machines, --help, -v/--version
examples:
  orca-axi
  orca-axi agents --all-machines
  orca-axi agents --all-machines --json
  orca-axi projects --all-machines
  orca-axi doctor --full
  orca-axi update --check
```

`fleet` contract:

```
usage: orca-axi [fleet] [--json] [--full] [--agents] [--all-machines]
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
flags[5]:
  --json,   --full,   --agents,   --all-machines, --help
examples:
  orca-axi
  orca-axi fleet --json
  orca-axi fleet --all-machines --json
  orca-axi agents --all-machines
  orca-axi doctor --full
```

`agents` contract:

```
usage: orca-axi agents [--all-machines] [--project <name>] [--active-only] [--summary-by-project] [--json]
description:
  Discover all running coding agents (claude, codex, agy, grok, opencode,
  cursor, gemini, cline, hermes) on this machine and optionally across all
  fleet machines (adi0, adi1, adi2, macmini, adi4). Correlates OS PIDs/CWDs
  with Antigravity brain locks, Orca worktrees/terminals, Herdr sessions,
  tmux panes, git branches, Linear issues, and project docs.
outputs:
  TOON summary: totals, machines[], items[] (or projects[] with --summary-by-project)
  --json  machine-readable {agents: ...} envelope
flags[6]:
  --all-machines,   --project <name>,   --active-only,   --summary-by-project,   --json, --help
examples:
  orca-axi agents
  orca-axi agents --all-machines --json
  orca-axi agents --all-machines --summary-by-project
  orca-axi agents --project firstmate --active-only
```

`doctor` contract:

```
usage: orca-axi doctor [--json] [--full]
description:
  Resolve and report the Orca terminal/session runtime binary. Probes
  each candidate with --version only, identifies the 1.x runtime versus
  the unrelated GNOME screen reader that shares the orca name, and
  refuses (structured report, exit 0) rather than mis-invoke it.
  ORCA_CLI_COMMAND (one path, spaces allowed) overrides the search. Doctor is a diagnostic,
  not a gate: it exits 0 in every case; branch on status, not the exit code.
checks[4]{name}:
  shim=~/.local/bin/orca resolves (dangling symlinks reported, not fatal)
  bundle=macOS .app Resources/bin or MacOS layout detected
  override=ORCA_CLI_COMMAND wins the search when set
  guard=Linux screen-reader/accessibility sessions refuse without explicit intent
outputs:
  TOON report: status, binary{path,source,version,identity}, reason?
  --full  adds candidates tried, broken symlinks, and session signals
  --json  the same report as JSON, wrapped as {doctor: ...}
flags[3]:
  --json,   --full, --help
examples:
  orca-axi doctor
  orca-axi doctor --full
  orca-axi doctor --json
```

## Exit codes

```
0  success (including idempotent no-ops and doctor diagnostics)
1  error: unexpected failure
2  usage error: unknown flag, unknown command, bad update option
```

Default stdout is TOON; `--json` is the machine escape hatch.
