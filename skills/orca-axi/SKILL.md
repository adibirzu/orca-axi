---
name: orca-axi
description: >
  Resolve and report the Orca terminal/session runtime binary, discover
  working coding agents across local and remote fleet hosts, and inspect the
  domain-organized workstation portfolio catalog.
---

# orca-axi

Resolve the Orca runtime binary and discover working coding agents across your fleet. Version 0.1.0.

Status: **Live fleet, agent radar, portfolio catalog, OB-4 mirror & hooks audit.** `fleet` (the no-arg dashboard),
`agents` / `projects`, `portfolio`, `doctor`, `mirror` (read-only Firstmate
fleet projection into Orca UI cards), and `hooks-audit` (read-only worktree
hook drift inspection) are live. `update`/`update --check`
are built in via axi-sdk-js.

Run it without a global install:

```sh
npx -y orca-axi
npx -y orca-axi agents --all-machines
npx -y orca-axi portfolio
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
branches, and Linear issues. `orca-axi portfolio` reads
`~/.config/orca-axi/portfolio-catalog.json` to inspect repositories grouped
across Linear Initiatives, domains, and tiers.

## Commands

```sh
npx -y orca-axi                       # fleet view (same as: orca-axi fleet)
npx -y orca-axi fleet --json
npx -y orca-axi agents --all-machines # cross-machine agent radar
npx -y orca-axi projects --by-domain  # group active projects by portfolio domain
npx -y orca-axi portfolio             # inspect repository & domain catalog
npx -y orca-axi doctor                # binary diagnosis
npx -y orca-axi doctor --full         # every candidate path tried
npx -y orca-axi doctor --json
npx -y orca-axi mirror --from snapshot.json   # read-only fleet cards
npx -y orca-axi hooks-audit --json            # read-only worktree hook drift audit
npx -y orca-axi update --check        # current vs latest, no install
```

Top-level surface:

```
usage: orca-axi [fleet|agents|projects|portfolio|doctor|mirror|hooks-audit] [flags]
commands[7]:
  (none)=fleet, agents, projects, portfolio, doctor, mirror, hooks-audit
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
  portfolio inspects ~/.config/orca-axi/portfolio-catalog.json across domains & tiers.
  mirror projects Firstmate fleet state into read-only Orca UI cards;
  it never mutates Firstmate or Orca state (see orca-axi mirror --help).
  hooks-audit performs a strictly read-only audit of orca.yaml,
  scripts/orca-worktree-*.sh, and commandSourcePolicy drift across repos.
flags[5]:
  --json, --full, --all-machines, --help, -v/--version
examples:
  orca-axi
  orca-axi agents --all-machines
  orca-axi projects --all-machines --by-domain
  orca-axi portfolio --domain 01 --tier 1
  orca-axi doctor --full
  orca-axi mirror --from snapshot.json
  orca-axi hooks-audit --json
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
usage: orca-axi agents [--all-machines] [--project <name>] [--active-only] [--summary-by-project] [--by-domain] [--tier <tier>] [--json]
description:
  Discover all running coding agents (claude, codex, agy, grok, opencode,
  cursor, gemini, cline, hermes) on this machine and optionally across all
  fleet machines (adi0, adi1, adi2, macmini, adi4). Correlates OS PIDs/CWDs
  with Antigravity brain locks, Orca worktrees/terminals, Herdr sessions,
  tmux panes, git branches, Linear issues, and project docs.
outputs:
  TOON summary: totals, machines[], items[] (or projects[] with --summary-by-project)
  --json  machine-readable {agents: ...} envelope
flags[8]:
  --all-machines,   --project <name>,   --active-only,   --summary-by-project,   --by-domain,   --tier <tier>,   --json, --help
examples:
  orca-axi agents
  orca-axi agents --all-machines --json
  orca-axi agents --all-machines --summary-by-project
  orca-axi projects --by-domain --tier 1
  orca-axi agents --project firstmate --active-only
```

`portfolio` contract:

```
usage: orca-axi portfolio [--domain <domain>] [--tier <tier>] [--project <query>] [--stack <stack>] [--full] [--json]
description:
  Inspect the workstation repository & Linear initiative catalog stored at
  ~/.config/orca-axi/portfolio-catalog.json (override via ORCA_AXI_PORTFOLIO_CATALOG).
  Falls back gracefully (exit 0, status=missing_catalog) when absent.
outputs:
  TOON summary: status, primaryStation, totals, domains[] (plus repositories[] with filters or --full)
  --json  machine-readable {portfolio: ...} envelope
flags[7]:
  --domain <domain>,   --tier <tier>,   --project <query>,   --stack <stack>,   --full,   --json, --help
examples:
  orca-axi portfolio
  orca-axi portfolio --domain 02 --tier 1
  orca-axi portfolio --project P-CYB-71 --json
  orca-axi portfolio --stack typescript --full
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

`mirror` contract (read-only projection, not a control plane; Orca-runtime
rendering is verified separately on the Mac where the desktop UI runs):

```
usage: orca-axi mirror [--from <path>] [--json] [--full]
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
flags[4]:
  --from,   --json,   --full, --help
examples:
  orca-axi mirror --from snapshot.json
  orca-axi mirror --from snapshot.json --json
  orca-axi mirror --from snapshot.json --full
```

`hooks-audit` contract (strictly read-only worktree hook & policy audit):

```
usage: orca-axi hooks-audit [--repo <path>] [--all] [--json]
description:
  Strictly read-only audit of Orca worktree hook configuration across
  registered Orca repos (and portfolio repos with --all, or one repo
  with --repo <path>). Resolves the Orca binary first (preserving the
  GNOME screen-reader guard), queries `orca repo list --json`, and
  safely inspects on-disk orca.yaml and scripts/orca-worktree-*.sh using
  O_NOFOLLOW reads without ever mutating repo files or Orca settings.
findings:
  missing_orca_yaml     checked-in orca.yaml is absent
  local_only_override   Orca commandSourcePolicy is local-only (bypasses orca.yaml)
  missing_archive_hook  archive hook missing in orca.yaml or script missing on disk
  unsafe_shared_dirs    sharedDirectories includes .venv, node_modules, .next, target, or caches
  missing_setup_script  orca.yaml references a setup script that does not exist on disk
  unsafe_symlink        hook file or scripts/ is a symlink, special file, or escapes repo root
  invalid_orca_yaml     orca.yaml could not be parsed as a valid YAML mapping
  missing_repo_dir      registered/catalog repo directory does not exist on disk
outputs:
  TOON summary: status, scope, summary{}, repos[]
  --json  machine-readable {hooksAudit: ...} envelope
flags[4]:
  --repo <path>,   --all,   --json, --help
examples:
  orca-axi hooks-audit
  orca-axi hooks-audit --json
  orca-axi hooks-audit --all --json
  orca-axi hooks-audit --repo ~/dev/orca-axi
```

## Exit codes

```
0  success (including idempotent no-ops and doctor diagnostics)
1  error: unexpected failure
2  usage error: unknown flag, unknown command, bad update option
```

Default stdout is TOON; `--json` is the machine escape hatch.
