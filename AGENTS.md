# orca-axi

- Sharp edge: `orca` is also the GNOME screen reader on Linux desktops. Never invoke a resolved binary for anything beyond the `--version` identity probe in `src/orca-resolve.ts`; the guard refusals there are load-bearing. See `README.md` for the doctrine.

Before changing binary resolution, read the [resolver](src/orca-resolve.ts) and [identity regressions](test/resolve.test.ts). [package.json](package.json) owns build, test and lint commands. Regenerate [the skill](skills/orca-axi/SKILL.md) from its [source](src/skill.ts); [the parity test](test/skill.test.ts) rejects stale generated guidance.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
