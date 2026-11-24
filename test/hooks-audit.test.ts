import {
  chmodSync,
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
import { hooksAuditCommand } from "../src/commands/hooks-audit.js";
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
});
