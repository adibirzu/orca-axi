# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Build/test: `npm test` (build + vitest), `npm run lint`, `npm run build:skill` (regenerate `skills/orca-axi/SKILL.md`; `test/skill.test.ts` fails when stale).
- Sharp edge: `orca` is also the GNOME screen reader on Linux desktops. Never invoke a resolved binary for anything beyond the `--version` identity probe in `src/orca-resolve.ts`; the guard refusals there are load-bearing. See `README.md` for the doctrine.


- Add durable project-specific notes here as they are discovered through real work.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
