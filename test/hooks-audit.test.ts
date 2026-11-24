import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { main } from "../src/cli.js";
import { hooksAuditCommand, parseOrcaYaml } from "../src/commands/hooks-audit.js";
import type { OrcaResolution } from "../src/orca-resolve.js";
import type { CatalogLoadResult } from "../src/portfolio/catalog.js";

let dir: string;
let savedExitCode: number | undefined;
const savedEnv: Record<string, string | undefined> = {};
const PROXIED_ENV = [
  "ORCA_CLI_COMMAND",
  "ORCA_AXI_PLATFORM",
  "ORCA_AXI_HOME",
  "ORCA_AXI_PORTFOLIO_CATALOG",
];

function okResolution(path = "/Users/test/.local/bin/orca"): OrcaResolution {
  return {
    status: "ok",
    platform: "darwin",
    binary: {
      path,
      source: "shim",
      bundle: false,
      identity: "orca-runtime",
      version: "1.4.219",
    },
    brokenSymlinks: [],
    missingCandidates: [],
    sessionSignals: [],
    sessionActive: false,
    suggestions: [],
  };
}

function refusedResolution(): OrcaResolution {
  return {
    status: "refused",
    platform: "linux",
    binary: {
      path: "/usr/bin/orca",
      source: "path",
      bundle: false,
      identity: "screen-reader",
      version: "46.1",
    },
    brokenSymlinks: [],
    missingCandidates: [],
    sessionSignals: ["ACCESSIBILITY_ENABLED=1"],
    sessionActive: true,
    reason:
      "Resolved /usr/bin/orca (46.1) is the GNOME screen reader, not the Orca terminal/session runtime. Refusing to mis-invoke it.",
    suggestions: ["Install the Orca 1.x runtime"],
  };
}

function errorResolution(): OrcaResolution {
  return {
    status: "error",
    platform: "linux",
    brokenSymlinks: [],
    missingCandidates: [],
    sessionSignals: [],
    sessionActive: false,
    reason: "No Orca terminal/session runtime binary was found.",
    suggestions: ["Install the Orca 1.x runtime"],
  };
}

function fakeOrca(version: string): string {
  const path = join(dir, `orca-${version.replace(/[^0-9a-z]/gi, "_")}`);
  writeFileSync(
    path,
    [
      "#!/bin/sh",
      `if [ "$1" = "--version" ]; then echo "${version}"; exit 0; fi`,
      'if [ "$1" = "repo" ] && [ "$2" = "list" ]; then echo \'{"ok":true,"result":{"repos":[]}}\'; exit 0; fi',
      "",
    ].join("\n"),
  );
  chmodSync(path, 0o755);
  return path;
}

function makeRepo(
  name: string,
  opts: {
    orcaYaml?: string;
    setupScript?: string;
    archiveScript?: string;
    envFile?: string;
  } = {},
): string {
  const repoPath = join(dir, "repos", name);
  mkdirSync(repoPath, { recursive: true });
  if (opts.orcaYaml !== undefined) {
    writeFileSync(join(repoPath, "orca.yaml"), opts.orcaYaml);
  }
  if (opts.setupScript !== undefined || opts.archiveScript !== undefined) {
    mkdirSync(join(repoPath, "scripts"), { recursive: true });
  }
  if (opts.setupScript !== undefined) {
    const p = join(repoPath, "scripts", "orca-worktree-setup.sh");
    writeFileSync(p, opts.setupScript);
    chmodSync(p, 0o755);
  }
  if (opts.archiveScript !== undefined) {
    const p = join(repoPath, "scripts", "orca-worktree-archive.sh");
    writeFileSync(p, opts.archiveScript);
    chmodSync(p, 0o755);
  }
  if (opts.envFile !== undefined) {
    writeFileSync(join(repoPath, ".env"), opts.envFile);
  }
  return repoPath;
}

function orcaRepoListJson(
  repos: Array<{
    displayName: string;
    path: string;
    commandSourcePolicy?: string;
    setup?: string;
    archive?: string;
  }>,
): string {
  return JSON.stringify({
    id: "req-1",
    ok: true,
    result: {
      repos: repos.map((r, i) => ({
        id: `repo-${i}`,
        displayName: r.displayName,
        path: r.path,
        hookSettings: {
          mode: "auto",
          setupRunPolicy: "run-by-default",
          setupAgentStartupPolicy: "start-immediately",
          scripts: {
            setup: r.setup ?? "",
            archive: r.archive ?? "",
          },
          ...(r.commandSourcePolicy ? { commandSourcePolicy: r.commandSourcePolicy } : {}),
        },
      })),
    },
  });
}

async function runCli(argv: string[]): Promise<{ output: string; exitCode: number }> {
  process.exitCode = 0;
  let output = "";
  await main({
    argv,
    stdout: {
      write: (chunk: string) => {
        output += chunk;
        return true;
      },
    },
  });
  return { output, exitCode: process.exitCode ?? 0 };
}

beforeEach(() => {
  savedExitCode = process.exitCode;
  process.exitCode = 0;
  for (const name of PROXIED_ENV) savedEnv[name] = process.env[name];
  dir = mkdtempSync(join(tmpdir(), "orca-axi-hooks-audit-"));
  delete process.env.ORCA_CLI_COMMAND;
  delete process.env.ORCA_AXI_PLATFORM;
  delete process.env.ORCA_AXI_HOME;
  delete process.env.ORCA_AXI_PORTFOLIO_CATALOG;
});

afterEach(() => {
  process.exitCode = savedExitCode ?? 0;
  for (const name of PROXIED_ENV) {
    if (savedEnv[name] === undefined) delete process.env[name];
    else process.env[name] = savedEnv[name];
  }
  rmSync(dir, { recursive: true, force: true });
});

describe("hooks-audit", () => {
  it("prints help contract on --help", async () => {
    const out = await hooksAuditCommand(["--help"]);
    expect(out).toContain("usage: orca-axi hooks-audit");
    expect(out).toContain("--repo");
    expect(out).toContain("--all");
    expect(out).toContain("--json");
  });

  it("rejects unknown flags and mutually exclusive --repo + --all", async () => {
    await expect(hooksAuditCommand(["--bogus"])).rejects.toThrow("unknown flag --bogus");
    const repoPath = makeRepo("r1");
    await expect(hooksAuditCommand(["--repo", repoPath, "--all"])).rejects.toThrow(
      /cannot combine --repo and --all/i,
    );
  });

  it("rejects --repo pointing to a nonexistent directory", async () => {
    await expect(
      hooksAuditCommand(["--repo", join(dir, "does-not-exist")], {
        resolve: () => okResolution(),
        runOrcaRepoList: () => orcaRepoListJson([]),
      }),
    ).rejects.toThrow(/does-not-exist|not found|directory/i);
  });

  it("refuses immediately when resolveOrca detects the GNOME screen reader", async () => {
    const runSpy = vi.fn(() => orcaRepoListJson([]));
    const out = await hooksAuditCommand(["--json"], {
      resolve: refusedResolution,
      runOrcaRepoList: runSpy,
    });
    expect(runSpy).not.toHaveBeenCalled();
    const parsed = JSON.parse(out) as {
      hooksAudit: { status: string; reason: string; repos: unknown[] };
    };
    expect(parsed.hooksAudit.status).toBe("refused");
    expect(parsed.hooksAudit.reason).toContain("screen reader");
    expect(parsed.hooksAudit.repos).toEqual([]);
  });

  it("reports structured error when Orca binary is missing and no --repo is given", async () => {
    const runSpy = vi.fn(() => orcaRepoListJson([]));
    const out = await hooksAuditCommand(["--json"], {
      resolve: errorResolution,
      runOrcaRepoList: runSpy,
    });
    expect(runSpy).not.toHaveBeenCalled();
    const parsed = JSON.parse(out) as { hooksAudit: { status: string; reason: string } };
    expect(parsed.hooksAudit.status).toBe("error");
    expect(parsed.hooksAudit.reason).toContain("No Orca");
  });

  it("audits clean repo with zero findings", async () => {
    const cleanRepo = makeRepo("clean-repo", {
      orcaYaml: [
        "scripts:",
        '  setup: "if [ -f scripts/orca-worktree-setup.sh ]; then bash scripts/orca-worktree-setup.sh; fi"',
        '  archive: "if [ -f scripts/orca-worktree-archive.sh ]; then bash scripts/orca-worktree-archive.sh; fi"',
        "setupAgentStartupPolicy: wait-for-setup",
        "",
      ].join("\n"),
      setupScript: "#!/usr/bin/env bash\necho setup\n",
      archiveScript: "#!/usr/bin/env bash\necho archive\n",
    });

    const out = await hooksAuditCommand(["--json"], {
      resolve: () => okResolution(),
      runOrcaRepoList: () => orcaRepoListJson([{ displayName: "clean-repo", path: cleanRepo }]),
    });

    const parsed = JSON.parse(out) as {
      hooksAudit: {
        status: string;
        summary: {
          totalRepos: number;
          cleanRepos: number;
          driftRepos: number;
          totalFindings: number;
        };
        repos: Array<{ name: string; status: string; findings: unknown[] }>;
      };
    };
    expect(parsed.hooksAudit.status).toBe("ok");
    expect(parsed.hooksAudit.summary.totalRepos).toBe(1);
    expect(parsed.hooksAudit.summary.cleanRepos).toBe(1);
    expect(parsed.hooksAudit.summary.driftRepos).toBe(0);
    expect(parsed.hooksAudit.summary.totalFindings).toBe(0);
    expect(parsed.hooksAudit.repos[0]?.status).toBe("clean");
    expect(parsed.hooksAudit.repos[0]?.findings).toEqual([]);
  });

  it("detects missing_orca_yaml, local_only_override, missing_archive_hook, and unsafe_shared_dirs", async () => {
    const missingYamlRepo = makeRepo("atlas-like");
    const setupOnlyYamlRepo = makeRepo("setup-only", {
      orcaYaml: [
        "scripts:",
        '  setup: "bash scripts/orca-worktree-setup.sh"',
        "",
      ].join("\n"),
      setupScript: "#!/usr/bin/env bash\necho setup\n",
    });
    const missingArchiveScriptRepo = makeRepo("missing-archive-script", {
      orcaYaml: [
        "scripts:",
        '  setup: "bash scripts/orca-worktree-setup.sh"',
        '  archive: "bash scripts/orca-worktree-archive.sh"',
        "",
      ].join("\n"),
      setupScript: "#!/usr/bin/env bash\necho setup\n",
    });
    const unsafeSharedRepo = makeRepo("unsafe-shared", {
      orcaYaml: [
        "scripts:",
        '  setup: "bash scripts/orca-worktree-setup.sh"',
        '  archive: "bash scripts/orca-worktree-archive.sh"',
        "sharedDirectories:",
        "  - .venv",
        "  - apps/web/node_modules",
        "  - .next",
        "  - target",
        "  - .cache",
        "",
      ].join("\n"),
      setupScript: "#!/usr/bin/env bash\necho setup\n",
      archiveScript: "#!/usr/bin/env bash\necho archive\n",
    });

    const out = await hooksAuditCommand(["--json"], {
      resolve: () => okResolution(),
      runOrcaRepoList: () =>
        orcaRepoListJson([
          {
            displayName: "atlas-like",
            path: missingYamlRepo,
            commandSourcePolicy: "local-only",
            setup: "npm install",
            archive: "",
          },
          {
            displayName: "setup-only",
            path: setupOnlyYamlRepo,
          },
          {
            displayName: "missing-archive-script",
            path: missingArchiveScriptRepo,
          },
          {
            displayName: "unsafe-shared",
            path: unsafeSharedRepo,
          },
        ]),
    });

    const parsed = JSON.parse(out) as {
      hooksAudit: {
        summary: {
          totalRepos: number;
          driftRepos: number;
          byCode: Record<string, number>;
        };
        repos: Array<{
          name: string;
          status: string;
          findings: Array<{ code: string; details?: Record<string, unknown> }>;
        }>;
      };
    };

    expect(parsed.hooksAudit.summary.totalRepos).toBe(4);
    expect(parsed.hooksAudit.summary.driftRepos).toBe(4);
    expect(parsed.hooksAudit.summary.byCode.missing_orca_yaml).toBe(1);
    expect(parsed.hooksAudit.summary.byCode.local_only_override).toBe(1);
    expect(parsed.hooksAudit.summary.byCode.missing_archive_hook).toBe(3);
    expect(parsed.hooksAudit.summary.byCode.unsafe_shared_dirs).toBe(1);

    const atlas = parsed.hooksAudit.repos.find((r) => r.name === "atlas-like");
    expect(atlas?.findings.map((f) => f.code)).toEqual(
      expect.arrayContaining(["missing_orca_yaml", "local_only_override", "missing_archive_hook"]),
    );

    const unsafe = parsed.hooksAudit.repos.find((r) => r.name === "unsafe-shared");
    const sharedFinding = unsafe?.findings.find((f) => f.code === "unsafe_shared_dirs");
    expect(sharedFinding).toBeDefined();
    expect(sharedFinding?.details?.unsafeDirs).toEqual(
      expect.arrayContaining([".venv", "apps/web/node_modules", ".next", "target", ".cache"]),
    );
  });

  it("supports --repo scoping and cross-references Orca local-only policy", async () => {
    const repoA = makeRepo("repo-a", {
      orcaYaml: [
        "scripts:",
        '  setup: "bash scripts/orca-worktree-setup.sh"',
        '  archive: "bash scripts/orca-worktree-archive.sh"',
      ].join("\n"),
      setupScript: "#!/bin/sh\necho ok\n",
      archiveScript: "#!/bin/sh\necho ok\n",
    });
    const repoB = makeRepo("repo-b");

    const out = await hooksAuditCommand(["--repo", repoA, "--json"], {
      resolve: () => okResolution(),
      runOrcaRepoList: () =>
        orcaRepoListJson([
          { displayName: "repo-a", path: repoA, commandSourcePolicy: "local-only" },
          { displayName: "repo-b", path: repoB },
        ]),
    });

    const parsed = JSON.parse(out) as {
      hooksAudit: {
        scope: string;
        summary: { totalRepos: number };
        repos: Array<{ name: string; findings: Array<{ code: string }> }>;
      };
    };
    expect(parsed.hooksAudit.scope).toBe("repo");
    expect(parsed.hooksAudit.summary.totalRepos).toBe(1);
    expect(parsed.hooksAudit.repos[0]?.name).toBe("repo-a");
    expect(parsed.hooksAudit.repos[0]?.findings.map((f) => f.code)).toContain("local_only_override");
  });

  it("merges and deduplicates Orca and portfolio repos with --all", async () => {
    const sharedRepo = makeRepo("shared-repo", {
      orcaYaml: [
        "scripts:",
        '  setup: "bash scripts/orca-worktree-setup.sh"',
        '  archive: "bash scripts/orca-worktree-archive.sh"',
      ].join("\n"),
      setupScript: "#!/bin/sh\necho ok\n",
      archiveScript: "#!/bin/sh\necho ok\n",
    });
    const portfolioOnlyRepo = makeRepo("portfolio-only");

    const catalogResult: CatalogLoadResult = {
      status: "ok",
      catalogPath: join(dir, "portfolio-catalog.json"),
      catalog: {
        schemaVersion: "portfolio-catalog.v1",
        primary_station: "adi0",
        domains: [],
        repositories: [
          {
            name: "shared-repo",
            path: sharedRepo,
            remote: null,
            domain: "01-fleet-and-harness",
            tier: "tier-1-primary",
            linear_project_id: null,
            linear_project_slug: null,
            linear_project_name: null,
            last_commit_at: null,
            primary_stack: "typescript",
          },
          {
            name: "portfolio-only",
            path: portfolioOnlyRepo,
            remote: null,
            domain: "01-fleet-and-harness",
            tier: "tier-2-active",
            linear_project_id: null,
            linear_project_slug: null,
            linear_project_name: null,
            last_commit_at: null,
            primary_stack: "python",
          },
        ],
      },
    };

    const out = await hooksAuditCommand(["--all", "--json"], {
      resolve: () => okResolution(),
      runOrcaRepoList: () => orcaRepoListJson([{ displayName: "shared-repo", path: sharedRepo }]),
      loadCatalog: () => catalogResult,
    });

    const parsed = JSON.parse(out) as {
      hooksAudit: {
        scope: string;
        summary: { totalRepos: number; cleanRepos: number; driftRepos: number };
        repos: Array<{ name: string; sources: string[] }>;
      };
    };
    expect(parsed.hooksAudit.scope).toBe("all");
    expect(parsed.hooksAudit.summary.totalRepos).toBe(2);
    expect(parsed.hooksAudit.summary.cleanRepos).toBe(1);
    expect(parsed.hooksAudit.summary.driftRepos).toBe(1);
    const shared = parsed.hooksAudit.repos.find((r) => r.name === "shared-repo");
    expect(shared?.sources).toEqual(["orca", "portfolio"]);
    const pOnly = parsed.hooksAudit.repos.find((r) => r.name === "portfolio-only");
    expect(pOnly?.sources).toEqual(["portfolio"]);
  });

  it("refuses to follow symlinks escaping repo boundaries or symlinked hook files", async () => {
    const outsideSecret = join(dir, "outside-secret.txt");
    writeFileSync(outsideSecret, "scripts:\n  setup: echo LEAKED_OUTSIDE_SECRET\n");

    const symYamlRepo = makeRepo("sym-yaml");
    symlinkSync(outsideSecret, join(symYamlRepo, "orca.yaml"));

    const symScriptsRepo = makeRepo("sym-scripts", {
      orcaYaml: [
        "scripts:",
        '  setup: "bash scripts/orca-worktree-setup.sh"',
        '  archive: "bash scripts/orca-worktree-archive.sh"',
      ].join("\n"),
    });
    const outsideDir = join(dir, "outside-dir");
    mkdirSync(outsideDir, { recursive: true });
    writeFileSync(join(outsideDir, "orca-worktree-setup.sh"), "#!/bin/sh\necho LEAKED\n");
    symlinkSync(outsideDir, join(symScriptsRepo, "scripts"));

    const traversalRepo = makeRepo("traversal", {
      orcaYaml: [
        "scripts:",
        '  setup: "bash ../../outside-secret.txt"',
        '  archive: "bash scripts/orca-worktree-archive.sh"',
      ].join("\n"),
      archiveScript: "#!/bin/sh\necho ok\n",
    });

    const out = await hooksAuditCommand(["--json"], {
      resolve: () => okResolution(),
      runOrcaRepoList: () =>
        orcaRepoListJson([
          { displayName: "sym-yaml", path: symYamlRepo },
          { displayName: "sym-scripts", path: symScriptsRepo },
          { displayName: "traversal", path: traversalRepo },
        ]),
    });

    expect(out).not.toContain("LEAKED_OUTSIDE_SECRET");
    const parsed = JSON.parse(out) as {
      hooksAudit: {
        repos: Array<{ name: string; findings: Array<{ code: string }> }>;
      };
    };
    expect(
      parsed.hooksAudit.repos.find((r) => r.name === "sym-yaml")?.findings.map((f) => f.code),
    ).toContain("unsafe_symlink");
    expect(
      parsed.hooksAudit.repos.find((r) => r.name === "sym-scripts")?.findings.map((f) => f.code),
    ).toContain("unsafe_symlink");
    expect(
      parsed.hooksAudit.repos.find((r) => r.name === "traversal")?.findings.map((f) => f.code),
    ).toContain("unsafe_symlink");
  });

  it("never leaks secrets, private IPs, .env values, or personal home identifiers", async () => {
    const leakyRepo = makeRepo("leaky-repo", {
      orcaYaml: [
        "# private endpoint http://192.168.1.50:8080 token ghp_secretTokenValue123456",
        "scripts:",
        '  setup: "TOKEN=ghp_secretTokenValue123456 bash scripts/orca-worktree-setup.sh"',
        '  archive: "bash scripts/orca-worktree-archive.sh"',
        "sharedDirectories:",
        "  - .venv",
      ].join("\n"),
      setupScript: [
        "#!/usr/bin/env bash",
        "export API_URL=http://10.0.0.42:4000",
        "PATH=/Users/alice/bin:$PATH",
      ].join("\n"),
      archiveScript: "#!/usr/bin/env bash\necho done\n",
      envFile: "SECRET_TOKEN=super_secret_123\nTAILSCALE_IP=100.91.62.28\n",
    });

    const orcaPayload = orcaRepoListJson([
      {
        displayName: "leaky-repo",
        path: leakyRepo,
        commandSourcePolicy: "local-only",
        setup: "API_KEY=sk-test-secret-999 curl http://100.85.233.75:3001",
        archive: "",
      },
    ]);

    const jsonOut = await hooksAuditCommand(["--json"], {
      resolve: () => okResolution(),
      runOrcaRepoList: () => orcaPayload,
    });
    const toonOut = await hooksAuditCommand([], {
      resolve: () => okResolution(),
      runOrcaRepoList: () => orcaPayload,
    });

    const forbidden = [
      "super_secret_123",
      "SECRET_TOKEN",
      "100.91.62.28",
      "192.168.1.50",
      "10.0.0.42",
      "100.85.233.75",
      "ghp_secretTokenValue123456",
      "sk-test-secret-999",
      "alice",
    ];
    for (const token of forbidden) {
      expect(jsonOut).not.toContain(token);
      expect(toonOut).not.toContain(token);
    }

    // Read-only verification: original files untouched
    expect(readFileSync(join(leakyRepo, ".env"), "utf8")).toContain("super_secret_123");
  });

  it("integrates with CLI main() for TOON, --json, --help, screen-reader guard, and unknown flag exit 2", async () => {
    const help = await runCli(["hooks-audit", "--help"]);
    expect(help.exitCode).toBe(0);
    expect(help.output).toContain("usage: orca-axi hooks-audit");

    const bad = await runCli(["hooks-audit", "--bogus"]);
    expect(bad.exitCode).toBe(2);
    expect(bad.output).toContain("unknown flag --bogus");

    process.env.ORCA_CLI_COMMAND = fakeOrca("46.1");
    process.env.ORCA_AXI_PLATFORM = "linux";
    const guard = await runCli(["hooks-audit", "--json"]);
    expect(guard.exitCode).toBe(0);
    const parsedGuard = JSON.parse(guard.output) as { hooksAudit: { status: string } };
    expect(parsedGuard.hooksAudit.status).toBe("refused");

    delete process.env.ORCA_AXI_PLATFORM;
    const repoPath = makeRepo("cli-repo", {
      orcaYaml: [
        "scripts:",
        '  setup: "bash scripts/orca-worktree-setup.sh"',
        '  archive: "bash scripts/orca-worktree-archive.sh"',
      ].join("\n"),
      setupScript: "#!/bin/sh\necho ok\n",
      archiveScript: "#!/bin/sh\necho ok\n",
    });
    process.env.ORCA_CLI_COMMAND = fakeOrca("1.4.219");
    const singleToon = await runCli(["hooks-audit", "--repo", repoPath]);
    expect(singleToon.exitCode).toBe(0);
    expect(singleToon.output).toContain("hooksAudit:");
    expect(singleToon.output).toContain("status: ok");
  });

  it("detects missing_setup_script, invalid_orca_yaml, empty_hook_script, and hardcoded_home_path", async () => {
    const missingSetupRepo = makeRepo("missing-setup", {
      orcaYaml: [
        "scripts:",
        '  setup: "bash scripts/orca-worktree-setup.sh"',
        '  archive: "bash scripts/orca-worktree-archive.sh"',
      ].join("\n"),
      archiveScript: "#!/bin/sh\necho ok\n",
    });
    const badYamlRepo = makeRepo("bad-yaml", {
      orcaYaml: "- not a mapping\n",
    });
    const emptyScriptRepo = makeRepo("empty-script", {
      orcaYaml: [
        "scripts:",
        '  setup: "bash scripts/orca-worktree-setup.sh"',
        '  archive: "bash scripts/orca-worktree-archive.sh"',
      ].join("\n"),
      setupScript: "   \n",
      archiveScript: "#!/bin/sh\n/Users/bob/bin/tool\n",
    });

    const out = await hooksAuditCommand(["--json"], {
      resolve: () => okResolution(),
      runOrcaRepoList: () =>
        orcaRepoListJson([
          { displayName: "missing-setup", path: missingSetupRepo },
          { displayName: "bad-yaml", path: badYamlRepo },
          { displayName: "empty-script", path: emptyScriptRepo },
        ]),
    });

    expect(out).not.toContain("bob");
    const parsed = JSON.parse(out) as {
      hooksAudit: {
        summary: { byCode: Record<string, number> };
        repos: Array<{ name: string; findings: Array<{ code: string }> }>;
      };
    };
    expect(parsed.hooksAudit.summary.byCode.missing_setup_script).toBe(1);
    expect(parsed.hooksAudit.summary.byCode.invalid_orca_yaml).toBe(1);
    expect(parsed.hooksAudit.summary.byCode.empty_hook_script).toBe(1);
    expect(parsed.hooksAudit.summary.byCode.hardcoded_home_path).toBe(1);
  });

  // --- R1 Regression Tests (Findings 1-6) ---

  it("P1: redacts hostile metadata (displayName, commandSourcePolicy), filenames, and screen-reader --version strings in JSON and TOON", async () => {
    const hostileRepo = makeRepo("hostile-repo", {
      orcaYaml: [
        "scripts:",
        '  setup: "bash scripts/missing-10.203.0.77-SYNTHETIC_SECRET_R1.sh"',
        '  archive: "bash scripts/archive-10.203.0.77-SYNTHETIC_SECRET_R1.sh"',
      ].join("\n"),
    });
    mkdirSync(join(hostileRepo, "scripts"), { recursive: true });
    writeFileSync(
      join(hostileRepo, "scripts", "orca-worktree-10.203.0.77-SYNTHETIC_SECRET_R1.sh"),
      "   \n",
    );

    const orcaPayload = orcaRepoListJson([
      {
        displayName: "tenant-r1-secret http://10.203.0.77 SYNTHETIC_SECRET_R1",
        path: hostileRepo,
        commandSourcePolicy: "local-only tenant-r1-secret",
      },
    ]);

    const jsonOut = await hooksAuditCommand(["--json"], {
      resolve: () => okResolution(),
      runOrcaRepoList: () => orcaPayload,
    });
    const toonOut = await hooksAuditCommand([], {
      resolve: () => okResolution(),
      runOrcaRepoList: () => orcaPayload,
    });

    for (const marker of ["tenant-r1-secret", "10.203.0.77", "SYNTHETIC_SECRET_R1"]) {
      expect(jsonOut).not.toContain(marker);
      expect(toonOut).not.toContain(marker);
    }
    const parsedMeta = JSON.parse(jsonOut) as {
      hooksAudit: { repos: Array<{ commandSourcePolicy: string | null }> };
    };
    expect(parsedMeta.hooksAudit.repos[0]?.commandSourcePolicy).not.toBe(
      "local-only tenant-r1-secret",
    );

    // Hostile GNOME screen-reader --version string
    process.env.ORCA_CLI_COMMAND = fakeOrca("46.1 http://10.203.0.77 SYNTHETIC_SECRET_R1");
    process.env.ORCA_AXI_PLATFORM = "linux";
    const guardJson = await runCli(["hooks-audit", "--json"]);
    const guardToon = await runCli(["hooks-audit"]);
    expect(guardJson.exitCode).toBe(0);
    expect(guardToon.exitCode).toBe(0);
    const parsedGuard = JSON.parse(guardJson.output) as {
      hooksAudit: { status: string; reason: string };
    };
    expect(parsedGuard.hooksAudit.status).toBe("refused");
    for (const marker of ["10.203.0.77", "SYNTHETIC_SECRET_R1"]) {
      expect(guardJson.output).not.toContain(marker);
      expect(guardToon.output).not.toContain(marker);
    }
  });

  it("P2: rejects hardlinked orca.yaml and hardlinked hook scripts (st_nlink > 1)", async () => {
    const outsideYaml = join(dir, "outside-orca.yaml");
    writeFileSync(
      outsideYaml,
      [
        "scripts:",
        '  setup: "echo HARDLINK_YAML_SECRET"',
        '  archive: "echo ok"',
      ].join("\n"),
    );
    const hardlinkYamlRepo = makeRepo("hardlink-yaml");
    linkSync(outsideYaml, join(hardlinkYamlRepo, "orca.yaml"));

    const outsideScript = join(dir, "outside-hook.sh");
    writeFileSync(outsideScript, "#!/bin/sh\necho HARDLINK_SCRIPT_SECRET\n");
    const hardlinkScriptsRepo = makeRepo("hardlink-scripts", {
      orcaYaml: [
        "scripts:",
        '  setup: "bash scripts/orca-worktree-setup.sh"',
        '  archive: "bash scripts/orca-worktree-archive.sh"',
      ].join("\n"),
    });
    mkdirSync(join(hardlinkScriptsRepo, "scripts"), { recursive: true });
    linkSync(outsideScript, join(hardlinkScriptsRepo, "scripts", "orca-worktree-setup.sh"));
    linkSync(outsideScript, join(hardlinkScriptsRepo, "scripts", "orca-worktree-archive.sh"));

    const out = await hooksAuditCommand(["--json"], {
      resolve: () => okResolution(),
      runOrcaRepoList: () =>
        orcaRepoListJson([
          { displayName: "hardlink-yaml", path: hardlinkYamlRepo },
          { displayName: "hardlink-scripts", path: hardlinkScriptsRepo },
        ]),
    });

    expect(out).not.toContain("HARDLINK_YAML_SECRET");
    expect(out).not.toContain("HARDLINK_SCRIPT_SECRET");
    const parsed = JSON.parse(out) as {
      hooksAudit: {
        repos: Array<{
          name: string;
          status: string;
          setupHookConfigured: boolean;
          archiveHookConfigured: boolean;
          findings: Array<{ code: string; message: string }>;
        }>;
      };
    };

    const yamlRepo = parsed.hooksAudit.repos.find((r) => r.name === "hardlink-yaml");
    expect(yamlRepo?.status).toBe("drift");
    expect(yamlRepo?.findings.map((f) => f.code)).toContain("unsafe_symlink");

    const scriptRepo = parsed.hooksAudit.repos.find((r) => r.name === "hardlink-scripts");
    expect(scriptRepo?.status).toBe("drift");
    expect(scriptRepo?.setupHookConfigured).toBe(false);
    expect(scriptRepo?.archiveHookConfigured).toBe(false);
    expect(scriptRepo?.findings.map((f) => f.code)).toContain("unsafe_symlink");
  });

  it("P2: handles YAML aliases, duplicate keys, invalid escapes, multiline flow arrays, inline maps, and block scalars accurately", async () => {
    // Rejects: alias, duplicate keys, invalid escape "\q"
    expect(parseOrcaYaml("sharedDirectories: [&dep .venv, *dep]\n")).toBeNull();
    expect(parseOrcaYaml("sharedDirectories:\n  - &dep .venv\n  - *dep\n")).toBeNull();
    expect(
      parseOrcaYaml(
        'scripts:\n  setup: "bash scripts/orca-worktree-setup.sh"\n  setup: "echo dup"\n',
      ),
    ).toBeNull();
    expect(
      parseOrcaYaml('scripts: { setup: "echo a", setup: "echo b" }\n'),
    ).toBeNull();
    expect(
      parseOrcaYaml('sharedDirectories:\n  - "\\q"\n'),
    ).toBeNull();
    expect(
      parseOrcaYaml('sharedDirectories: ["\\q"]\n'),
    ).toBeNull();

    expect(
      parseOrcaYaml(
        'scripts:\n  setup: |\n    bash scripts/orca-worktree-setup.sh\n  archive: >-\n    bash scripts/orca-worktree-archive.sh\n',
      ),
    ).toEqual({
      setupCommand: "bash scripts/orca-worktree-setup.sh\n",
      archiveCommand: "bash scripts/orca-worktree-archive.sh",
      sharedDirectories: [],
    });

    // Accepts: multiline flow array, inline scripts map, block scalars
    const inlineAndMultilineFlow = makeRepo("inline-multiline", {
      orcaYaml: [
        'scripts: { setup: "bash scripts/orca-worktree-setup.sh", archive: "bash scripts/orca-worktree-archive.sh" }',
        "sharedDirectories: [",
        "  .venv,",
        "  # comment inside flow array",
        '  "apps/web/node_modules",',
        "]",
      ].join("\n"),
      setupScript: "#!/bin/sh\necho setup\n",
      archiveScript: "#!/bin/sh\necho archive\n",
    });

    const blockScalarRepo = makeRepo("block-scalar", {
      orcaYaml: [
        "scripts:",
        "  setup: |",
        "    if [ -f scripts/orca-worktree-setup.sh ]; then",
        "      bash scripts/orca-worktree-setup.sh && echo *.sh",
        "    fi",
        "  archive: >-",
        "    bash scripts/orca-worktree-archive.sh",
      ].join("\n"),
      setupScript: "#!/bin/sh\necho setup\n",
      archiveScript: "#!/bin/sh\necho archive\n",
    });

    const aliasRepo = makeRepo("alias-repo", {
      orcaYaml: [
        "scripts:",
        '  setup: "bash scripts/orca-worktree-setup.sh"',
        '  archive: "bash scripts/orca-worktree-archive.sh"',
        "sharedDirectories:",
        "  - &dep .venv",
        "  - *dep",
      ].join("\n"),
      setupScript: "#!/bin/sh\necho setup\n",
      archiveScript: "#!/bin/sh\necho archive\n",
    });

    const out = await hooksAuditCommand(["--json"], {
      resolve: () => okResolution(),
      runOrcaRepoList: () =>
        orcaRepoListJson([
          { displayName: "inline-multiline", path: inlineAndMultilineFlow },
          { displayName: "block-scalar", path: blockScalarRepo },
          { displayName: "alias-repo", path: aliasRepo },
        ]),
    });

    const parsed = JSON.parse(out) as {
      hooksAudit: {
        repos: Array<{
          name: string;
          status: string;
          setupHookConfigured: boolean;
          archiveHookConfigured: boolean;
          findings: Array<{ code: string; details?: Record<string, unknown> }>;
        }>;
      };
    };

    const inlineRepo = parsed.hooksAudit.repos.find((r) => r.name === "inline-multiline");
    expect(inlineRepo?.setupHookConfigured).toBe(true);
    expect(inlineRepo?.archiveHookConfigured).toBe(true);
    expect(inlineRepo?.findings.map((f) => f.code)).toEqual(["unsafe_shared_dirs"]);
    expect(inlineRepo?.findings[0]?.details?.unsafeDirs).toEqual([
      ".venv",
      "apps/web/node_modules",
    ]);

    const blockRepo = parsed.hooksAudit.repos.find((r) => r.name === "block-scalar");
    expect(blockRepo?.status).toBe("clean");
    expect(blockRepo?.setupHookConfigured).toBe(true);
    expect(blockRepo?.archiveHookConfigured).toBe(true);
    expect(blockRepo?.findings).toEqual([]);

    const badAliasRepo = parsed.hooksAudit.repos.find((r) => r.name === "alias-repo");
    expect(badAliasRepo?.status).toBe("drift");
    expect(badAliasRepo?.findings.map((f) => f.code)).toContain("invalid_orca_yaml");
  });

  it("P2: flags oversized and unreadable hook scripts rather than treating them as clean/configured", async () => {
    const oversizedRepo = makeRepo("oversized-script", {
      orcaYaml: [
        "scripts:",
        '  setup: "bash scripts/orca-worktree-setup.sh"',
        '  archive: "bash scripts/orca-worktree-archive.sh"',
      ].join("\n"),
      setupScript: "x".repeat(256 * 1024 + 1),
      archiveScript: "#!/bin/sh\necho archive\n",
    });

    const unreadableRepo = makeRepo("unreadable-script", {
      orcaYaml: [
        "scripts:",
        '  setup: "bash scripts/orca-worktree-setup.sh"',
        '  archive: "bash scripts/orca-worktree-archive.sh"',
      ].join("\n"),
      setupScript: "#!/bin/sh\necho setup\n",
      archiveScript: "#!/bin/sh\necho archive\n",
    });
    chmodSync(join(unreadableRepo, "scripts", "orca-worktree-archive.sh"), 0o000);

    try {
      const out = await hooksAuditCommand(["--json"], {
        resolve: () => okResolution(),
        runOrcaRepoList: () =>
          orcaRepoListJson([
            { displayName: "oversized-script", path: oversizedRepo },
            { displayName: "unreadable-script", path: unreadableRepo },
          ]),
      });

      const parsed = JSON.parse(out) as {
        hooksAudit: {
          repos: Array<{
            name: string;
            status: string;
            setupHookConfigured: boolean;
            archiveHookConfigured: boolean;
            findings: Array<{ code: string }>;
          }>;
        };
      };

      const oversized = parsed.hooksAudit.repos.find((r) => r.name === "oversized-script");
      expect(oversized?.status).toBe("drift");
      expect(oversized?.setupHookConfigured).toBe(false);
      expect(oversized?.findings.map((f) => f.code)).toContain("oversized_hook");

      const unreadable = parsed.hooksAudit.repos.find((r) => r.name === "unreadable-script");
      expect(unreadable?.status).toBe("drift");
      expect(unreadable?.archiveHookConfigured).toBe(false);
      expect(unreadable?.findings.map((f) => f.code)).toContain("unreadable_hook");
    } finally {
      chmodSync(join(unreadableRepo, "scripts", "orca-worktree-archive.sh"), 0o755);
    }
  });

  it("P2: treats Orca error envelopes, missing --all catalog, and --repo without Orca consistently without false status ok", async () => {
    // 1. { ok: false, error: ... } envelope
    const errEnvOut = await hooksAuditCommand(["--json"], {
      resolve: () => okResolution(),
      runOrcaRepoList: () =>
        JSON.stringify({
          id: "req-err",
          ok: false,
          error: "daemon offline 10.203.0.77 SYNTHETIC_SECRET_R1",
        }),
    });
    expect(errEnvOut).not.toContain("10.203.0.77");
    expect(errEnvOut).not.toContain("SYNTHETIC_SECRET_R1");
    const parsedErrEnv = JSON.parse(errEnvOut) as {
      hooksAudit: { status: string; reason?: string };
    };
    expect(parsedErrEnv.hooksAudit.status).toBe("error");
    expect(parsedErrEnv.hooksAudit.reason).toBeDefined();

    // 2. --all with missing catalog when Orca resolution succeeds
    const cleanRepo = makeRepo("orca-only-repo", {
      orcaYaml: [
        "scripts:",
        '  setup: "bash scripts/orca-worktree-setup.sh"',
        '  archive: "bash scripts/orca-worktree-archive.sh"',
      ].join("\n"),
      setupScript: "#!/bin/sh\necho setup\n",
      archiveScript: "#!/bin/sh\necho archive\n",
    });
    const missingCatalogOut = await hooksAuditCommand(["--all", "--json"], {
      resolve: () => okResolution(),
      runOrcaRepoList: () =>
        orcaRepoListJson([{ displayName: "orca-only-repo", path: cleanRepo }]),
      loadCatalog: () => ({
        status: "missing_catalog",
        catalogPath: join(dir, "missing-catalog.json"),
        catalog: null,
      }),
    });
    const parsedMissingCat = JSON.parse(missingCatalogOut) as {
      hooksAudit: { status: string; scope: string; catalogReason?: string };
    };
    expect(parsedMissingCat.hooksAudit.scope).toBe("all");
    expect(parsedMissingCat.hooksAudit.status).not.toBe("ok");
    expect(["degraded", "error"]).toContain(parsedMissingCat.hooksAudit.status);
    expect(parsedMissingCat.hooksAudit.catalogReason).toBeDefined();

    // 3. --repo <path> when Orca is unavailable: degraded top-level, clean on-disk repo
    const explicitOut = await hooksAuditCommand(["--repo", cleanRepo, "--json"], {
      resolve: errorResolution,
    });
    const parsedExplicit = JSON.parse(explicitOut) as {
      hooksAudit: {
        status: string;
        scope: string;
        orcaReason?: string;
        repos: Array<{ status: string }>;
      };
    };
    expect(parsedExplicit.hooksAudit.scope).toBe("repo");
    expect(parsedExplicit.hooksAudit.status).toBe("degraded");
    expect(parsedExplicit.hooksAudit.orcaReason).toBeDefined();
    expect(parsedExplicit.hooksAudit.repos[0]?.status).toBe("clean");
  });

  it("P2: exits non-zero (1) on operational query/catalog failures while emitting structured JSON/TOON", async () => {
    // 1. Fake Orca exiting 7 with secret on stderr
    const failOrca = join(dir, "orca-fail-7");
    writeFileSync(
      failOrca,
      [
        "#!/bin/sh",
        'if [ "$1" = "--version" ]; then echo "1.4.219"; exit 0; fi',
        'if [ "$1" = "repo" ] && [ "$2" = "list" ]; then echo "SYNTHETIC_SECRET_R1 10.203.0.77" >&2; exit 7; fi',
        "",
      ].join("\n"),
    );
    chmodSync(failOrca, 0o755);
    process.env.ORCA_CLI_COMMAND = failOrca;

    const failRes = await runCli(["hooks-audit", "--json"]);
    expect(failRes.exitCode).toBe(1);
    expect(failRes.output).not.toContain("SYNTHETIC_SECRET_R1");
    expect(failRes.output).not.toContain("10.203.0.77");
    const parsedFail = JSON.parse(failRes.output) as { hooksAudit: { status: string } };
    expect(parsedFail.hooksAudit.status).toBe("error");

    // 2. Fake Orca emitting invalid JSON
    const badJsonOrca = join(dir, "orca-bad-json");
    writeFileSync(
      badJsonOrca,
      [
        "#!/bin/sh",
        'if [ "$1" = "--version" ]; then echo "1.4.219"; exit 0; fi',
        'if [ "$1" = "repo" ] && [ "$2" = "list" ]; then echo "not json {"; exit 0; fi',
        "",
      ].join("\n"),
    );
    chmodSync(badJsonOrca, 0o755);
    process.env.ORCA_CLI_COMMAND = badJsonOrca;

    const badJsonRes = await runCli(["hooks-audit", "--json"]);
    expect(badJsonRes.exitCode).toBe(1);
    const parsedBadJson = JSON.parse(badJsonRes.output) as { hooksAudit: { status: string } };
    expect(parsedBadJson.hooksAudit.status).toBe("error");

    // 3. --all with missing catalog exits 1
    process.env.ORCA_CLI_COMMAND = fakeOrca("1.4.219");
    process.env.ORCA_AXI_HOME = join(dir, "empty-home");
    const missingCatCli = await runCli(["hooks-audit", "--all", "--json"]);
    expect(missingCatCli.exitCode).toBe(1);
    const parsedMissingCli = JSON.parse(missingCatCli.output) as {
      hooksAudit: { status: string };
    };
    expect(parsedMissingCli.hooksAudit.status).not.toBe("ok");
  });
});
