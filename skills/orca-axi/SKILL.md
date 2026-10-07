---
name: orca-axi
description: >
  Resolve and report the Orca terminal/session runtime binary: which orca
  is on PATH, runtime vs GNOME screen-reader identity, and the Linux
  accessibility guard. Use when checking Orca availability, debugging a
  broken orca shim, or choosing the binary a session should invoke.
---

# orca-axi

Resolve and report the Orca terminal/session runtime binary. Version 0.1.0.

Status: **OB-4 mirror.** `fleet` (the no-arg dashboard), `doctor`,
and `mirror` (read-only Firstmate fleet projection into Orca UI cards)
are live. `update`/`update --check` are built in via axi-sdk-js.

Run it without a global install:

```sh
npx -y orca-axi
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

## Commands

```sh
npx -y orca-axi                       # fleet view (same as: orca-axi fleet)
npx -y orca-axi fleet --json
npx -y orca-axi doctor                # binary diagnosis
npx -y orca-axi doctor --full          # every candidate path tried
npx -y orca-axi doctor --json
npx -y orca-axi mirror --from snapshot.json   # read-only fleet cards
npx -y orca-axi update --check        # current vs latest, no install
```

Top-level surface:

```
usage: orca-axi [fleet|doctor|mirror] [flags]
commands[3]:
  (none)=fleet, doctor, mirror
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
  mirror projects Firstmate fleet state into read-only Orca UI cards;
  it never mutates Firstmate or Orca state (see orca-axi mirror --help).
flags[3]:
  --json, --full, --help, -v/--version
examples:
  orca-axi
  orca-axi fleet --json
  orca-axi doctor
  orca-axi doctor --full
  orca-axi mirror --from snapshot.json
  orca-axi update --check
```

`fleet` contract:

```
usage: orca-axi [fleet] [--json] [--full]
description:
  Show the Orca fleet view: the resolved runtime binary, its version
  and identity, and the screen-reader guard state. Bare orca-axi runs
  this view. A refused status means the guard fired; see the reason and
  run orca-axi doctor for the full diagnosis.
outputs:
  TOON summary: status, binary{path,source,version,identity}, reason?
  --full  adds candidates tried, broken symlinks, and session signals
  --json  the same view as JSON
flags[3]:
  --json,   --full, --help
examples:
  orca-axi
  orca-axi fleet --json
  orca-axi doctor --full
```

`doctor` contract:

```
usage: orca-axi doctor [--json] [--full]
description:
  Resolve and report the Orca terminal/session runtime binary. Probes
  each candidate with --version only, identifies the 1.x runtime versus
  the unrelated GNOME screen reader that shares the orca name, and
  refuses (structured report, exit 0) rather than mis-invoke it.
  ORCA_CLI_COMMAND overrides the search. Doctor is a diagnostic,
  not a gate: it exits 0 in every case; branch on status, not the exit code.
checks[4]{name}:
  shim=~/.local/bin/orca resolves (dangling symlinks reported, not fatal)
  bundle=macOS .app Resources/bin or MacOS layout detected
  override=ORCA_CLI_COMMAND wins the search when set
  guard=Linux screen-reader/accessibility sessions refuse without explicit intent
outputs:
  TOON report: status, binary{path,source,version,identity}, reason?
  --full  adds candidates tried, broken symlinks, and session signals
  --json  the same report as JSON
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

## Exit codes

```
0  success (including idempotent no-ops and doctor diagnostics)
1  error: unexpected failure
2  usage error: unknown flag, unknown command, bad update option
```

Default stdout is TOON; `--json` is the machine escape hatch.
