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
orca-axi                  # fleet view (same as: orca-axi fleet)
orca-axi fleet --json
orca-axi doctor           # binary diagnosis
orca-axi doctor --full    # every candidate path tried
orca-axi doctor --json
orca-axi update --check   # current vs latest, no install
```

`ORCA_CLI_COMMAND` overrides the binary search when set. `doctor` is a
diagnostic, not a gate: it exits 0 in every case, so branch on the
reported `status` (`ok` | `refused` | `error`), not the exit code.

Default stdout is TOON; `--json` is the machine escape hatch.

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
