# orca-axi

AXI CLI that resolves and reports the Orca terminal/session runtime binary,
following `kunchenguid/axi` conventions.

## Why this tool exists

`orca` is two unrelated programs sharing one name: the Orca
terminal/session runtime (1.x, this tool's subject) and the GNOME screen
reader that ships as `/usr/bin/orca` on most Linux desktops. orca-axi
probes every candidate with `--version` only, tells the two apart, and
refuses with a structured report (exit 0) rather than mis-invoke the
screen reader for terminal control.

## Install

```sh
npm install -g orca-axi
# or run without installing:
npx -y orca-axi
```

## Commands

```sh
orca-axi                                      # fleet view (same as: orca-axi fleet)
orca-axi fleet --all-machines --json          # fleet binary + cross-machine agent summary
orca-axi agents [--all-machines] [--json]     # discover all working agents across fleet
orca-axi agents --project firstmate --active-only
orca-axi projects --all-machines              # group running agents by project + Linear/docs
orca-axi projects --by-domain --tier 1        # filter/group active projects by portfolio domain & tier
orca-axi portfolio [--domain 01] [--tier 1]   # inspect ~/.config/orca-axi/portfolio-catalog.json
orca-axi doctor                               # binary diagnosis
orca-axi doctor --full                        # every candidate path tried
orca-axi doctor --json
orca-axi mirror --from snapshot.json          # read-only Firstmate fleet cards
orca-axi mirror --from snapshot.json --json   # machine-readable cards
orca-axi update --check                       # current vs latest, no install
```

`mirror` projects Firstmate fleet state (the `fm-fleet-snapshot.sh --json`
document: task states, in-flight work, PR links) into Orca UI cards carrying
their Orca project/host/environment placement as a render hint. It is a
projection, not a control plane: cards are `readOnly` with no controls,
nothing here mutates Firstmate state, and nothing here invokes an Orca
mutating command. Whether a card actually paints inside the real Orca app is
verified separately on the Mac where the desktop UI runs.

`ORCA_CLI_COMMAND` overrides the binary search when set; its value is one
path to the binary (spaces allowed), not a command line. `doctor` is a
diagnostic, not a gate: it exits 0 in every case, so branch on the
reported `status` (`ok` | `refused` | `error`), not the exit code.

Default stdout is TOON; `--json` is the machine escape hatch.

Paperclip resolves the sync ledger path from `options.ledgerPath`,
`PAPERCLIP_SYNC_LEDGER`, `options.fmHome`, then `FM_HOME`, in that order. It
trims each value. `paperclip-cyb sync` also requires `options.fmHome` or
`FM_HOME` to discover FirstMate tasks. If a required binding is missing or
blank, the command stops without guessing a machine home.

## Exit codes

```
0  success (including idempotent no-ops and doctor diagnostics)
1  error: unexpected failure
2  usage error: unknown flag, unknown command, bad update option
```

## Development

```sh
npm install
npm test            # build + vitest
npm run build:skill # regenerate skills/orca-axi/SKILL.md
npm run lint
```

## License

MIT. See [LICENSE](LICENSE).
