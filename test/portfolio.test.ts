import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { main } from "../src/cli.js";
import { agentsCommand } from "../src/commands/agents.js";
import type { FleetAgentsReport } from "../src/agents/types.js";
import {
  filterPortfolioRepositories,
  loadPortfolioCatalog,
  lookupRepoCatalogEntry,
  matchesDomainQuery,
  normalizeTierFilter,
  sanitizeRemoteUrl,
  summarizePortfolioDomains,
  type PortfolioCatalog,
} from "../src/portfolio/catalog.js";

function sampleDomain(
  slug: string,
  code: string,
  name: string,
  label: string,
  initiative_id: string,
  initiative_url: string,
  workspace_dir: string,
): PortfolioCatalog["domains"][number] {
  return {
    key: slug,
    code,
    name,
    label,
    initiative_id,
    initiative_url,
    workspace_dir,
  };
}

const SAMPLE_CATALOG: PortfolioCatalog = {
  schemaVersion: "portfolio-catalog.v1",
  generatedAt: "2026-11-12T07:40:00+02:00",
  primary_station: "adi0",
  dev_root: "/Users/adrianb/dev",
  workspaces_root: "/Users/adrianb/Workspaces",
  domains: [
    sampleDomain(
      "01-fleet-and-harness",
      "01",
      "01 — Fleet, Harness² & Developer Platform",
      "domain:fleet-harness",
      "I-3",
      "https://linear.app/cyber-sec/initiative/01-fleet-harness",
      "/Users/adrianb/Workspaces/01-fleet-and-harness",
    ),
    sampleDomain(
      "02-pentforge-and-security",
      "02",
      "02 — Pentforge & Cybersecurity Products",
      "domain:pentforge-security",
      "I-4",
      "https://linear.app/cyber-sec/initiative/02-pentforge",
      "/Users/adrianb/Workspaces/02-pentforge-and-security",
    ),
    sampleDomain(
      "03-erp-logistics-and-finance",
      "03",
      "03 — Enterprise ERP, Logistics & Finance",
      "domain:erp-logistics-finance",
      "I-5",
      "https://linear.app/cyber-sec/initiative/03-erp",
      "/Users/adrianb/Workspaces/03-erp-logistics-and-finance",
    ),
  ],
  repositories: [
    {
      name: "orca-axi",
      path: "/Users/adrianb/dev/orca-axi",
      remote: "https://github.com/adibirzu/orca-axi.git",
      domain: "01-fleet-and-harness",
      tier: "tier-1-primary",
      linear_project_id: "P-CYB-73",
      linear_project_slug: "orca-and-axi-plugins-5c2872709705",
      linear_project_name: "Orca & AXI Plugins",
      last_commit_at: "2026-11-12T07:06:00+02:00",
      primary_stack: "typescript",
    },
    {
      name: "craft-anything",
      path: "/Users/adrianb/dev/craft-anything",
      remote: "https://github.com/adibirzu/craft-anything.git",
      domain: "01-fleet-and-harness",
      tier: "tier-2-active",
      linear_project_id: "P-OCD-70",
      linear_project_slug: "reviewforge-automatic-github-code-review-4bed8226ecec",
      linear_project_name: "ReviewForge — Automatic GitHub Code Review",
      last_commit_at: "2026-11-04T12:00:00Z",
      primary_stack: "rust",
    },
    {
      name: "pentforge-documentum",
      path: "/Users/adrianb/dev/pentforge-documentum",
      remote: "https://github.com/Pentforge-io/documentum.git",
      domain: "02-pentforge-and-security",
      tier: "tier-1-primary",
      linear_project_id: "P-CYB-71",
      linear_project_slug: "pentforge-documentum-cef455169a6c",
      linear_project_name: "Pentforge Documentum",
      last_commit_at: "2026-11-12T05:00:00Z",
      primary_stack: "typescript",
    },
    {
      name: "hexforge",
      path: "/Users/adrianb/dev/hexforge",
      remote: "https://github.com/adibirzu/hexforge.git",
      domain: "02-pentforge-and-security",
      tier: "tier-3-reference",
      linear_project_id: "P-CYB-2",
      linear_project_slug: "aetherops-58ef0e92b37c",
      linear_project_name: "AetherOps",
      last_commit_at: "2026-08-30T10:00:00Z",
      primary_stack: "python",
    },
  ],
};

let dir: string;
let savedExitCode: number | undefined;
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ["ORCA_AXI_PORTFOLIO_CATALOG", "ORCA_AXI_HOME"];

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
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  dir = mkdtempSync(join(tmpdir(), "orca-axi-portfolio-test-"));
  delete process.env.ORCA_AXI_PORTFOLIO_CATALOG;
  delete process.env.ORCA_AXI_HOME;
});

afterEach(() => {
  process.exitCode = savedExitCode ?? 0;
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  rmSync(dir, { recursive: true, force: true });
});

describe("portfolio catalog loader and pure filters", () => {
  it("returns missing_catalog gracefully when file does not exist", () => {
    const missingPath = join(dir, "nonexistent.json");
    const result = loadPortfolioCatalog({ catalogPath: missingPath });
    expect(result.status).toBe("missing_catalog");
    expect(result.catalog).toBeNull();
    expect(result.catalogPath).toBe(missingPath);
  });

  it("returns invalid_catalog gracefully on malformed JSON, bad schemaVersion, or invalid tier", () => {
    const badJsonPath = join(dir, "bad.json");
    writeFileSync(badJsonPath, "{not-valid-json");
    const res1 = loadPortfolioCatalog({ catalogPath: badJsonPath });
    expect(res1.status).toBe("invalid_catalog");
    expect(res1.error).toContain("JSON");

    const badSchemaPath = join(dir, "bad-schema.json");
    writeFileSync(
      badSchemaPath,
      JSON.stringify({ schemaVersion: "wrong.v0", domains: [], repositories: [] }),
    );
    const res2 = loadPortfolioCatalog({ catalogPath: badSchemaPath });
    expect(res2.status).toBe("invalid_catalog");
    expect(res2.error).toContain("portfolio-catalog.v1");

    const badTierPath = join(dir, "bad-tier.json");
    writeFileSync(
      badTierPath,
      JSON.stringify({
        ...SAMPLE_CATALOG,
        repositories: [{ ...SAMPLE_CATALOG.repositories[0], tier: "tier-typo" }],
      }),
    );
    const res3 = loadPortfolioCatalog({ catalogPath: badTierPath });
    expect(res3.status).toBe("invalid_catalog");
    expect(res3.error).toContain("Invalid repository entry");
  });

  it("strips embedded userinfo credentials from git remote URLs on load", () => {
    const singleUserUrl = ["https://", "placeholder-user", "@github.com/adibirzu/orca-axi.git"].join(
      "",
    );
    const basicUserInfoUrl = ["https://", "user", ":", "pass", "@github.com/org/repo.git"].join("");
    const repoUserInfoUrl = [
      "https://",
      "oauth-user",
      ":",
      "redacted-fixture",
      "@github.com/adibirzu/orca-axi.git",
    ].join("");

    expect(sanitizeRemoteUrl(singleUserUrl)).toBe("https://github.com/adibirzu/orca-axi.git");
    expect(sanitizeRemoteUrl(basicUserInfoUrl)).toBe("https://github.com/org/repo.git");
    expect(sanitizeRemoteUrl("git@github.com:adibirzu/orca-axi.git")).toBe(
      "git@github.com:adibirzu/orca-axi.git",
    );

    const credCatalogPath = join(dir, "cred-catalog.json");
    writeFileSync(
      credCatalogPath,
      JSON.stringify({
        ...SAMPLE_CATALOG,
        repositories: [
          {
            ...SAMPLE_CATALOG.repositories[0],
            remote: repoUserInfoUrl,
          },
        ],
      }),
    );
    const loaded = loadPortfolioCatalog({ catalogPath: credCatalogPath });
    expect(loaded.status).toBe("ok");
    expect(loaded.catalog?.repositories[0]?.remote).toBe("https://github.com/adibirzu/orca-axi.git");
  });

  it("loads default ~/.config/orca-axi/portfolio-catalog.json via ORCA_AXI_HOME", () => {
    const cfgDir = join(dir, ".config", "orca-axi");
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(join(cfgDir, "portfolio-catalog.json"), JSON.stringify(SAMPLE_CATALOG));

    const res = loadPortfolioCatalog({ homeDir: dir });
    expect(res.status).toBe("ok");
    expect(res.catalog?.primary_station).toBe("adi0");
    expect(res.catalog?.repositories).toHaveLength(4);
  });

  it("handles numeric/short domain queries without substring ambiguity and preserves orphan repos", () => {
    const domainMap = new Map(SAMPLE_CATALOG.domains.map((d) => [d.key, d]));
    expect(matchesDomainQuery("01-fleet-and-harness", domainMap, "1")).toBe(true);
    expect(matchesDomainQuery("02-pentforge-and-security", domainMap, "1")).toBe(false);
    expect(matchesDomainQuery("01-fleet-and-harness", domainMap, "0")).toBe(false);
    expect(matchesDomainQuery("01-fleet-and-harness", domainMap, "i-3")).toBe(true);

    expect(normalizeTierFilter("1")).toBe("tier-1-primary");
    expect(normalizeTierFilter("tier-2")).toBe("tier-2-active");
    expect(normalizeTierFilter("tier:3-incubating")).toBe("tier-3-reference");
    expect(normalizeTierFilter("0")).toBeNull();

    const byCode = filterPortfolioRepositories(SAMPLE_CATALOG, { domain: "1" });
    expect(byCode.map((r) => r.name)).toEqual(["orca-axi", "craft-anything"]);

    const byLabelAndTier = filterPortfolioRepositories(SAMPLE_CATALOG, {
      domain: "domain:pentforge-security",
      tier: "1",
    });
    expect(byLabelAndTier.map((r) => r.name)).toEqual(["pentforge-documentum"]);

    const byLinearId = filterPortfolioRepositories(SAMPLE_CATALOG, { project: "P-OCD-70" });
    expect(byLinearId.map((r) => r.name)).toEqual(["craft-anything"]);

    const byStack = filterPortfolioRepositories(SAMPLE_CATALOG, { stack: "python" });
    expect(byStack.map((r) => r.name)).toEqual(["hexforge"]);

    const withOrphan = [
      ...SAMPLE_CATALOG.repositories,
      {
        ...SAMPLE_CATALOG.repositories[0]!,
        name: "mystery-lab",
        domain: "unknown-domain",
      },
    ];
    const domainSummaries = summarizePortfolioDomains(SAMPLE_CATALOG.domains, withOrphan);
    const totalCounted = domainSummaries.reduce((s, d) => s + d.repoCount, 0);
    expect(totalCounted).toBe(withOrphan.length);
    expect(domainSummaries.at(-1)?.key).toBe("unclassified");
  });

  it("prioritizes exact path over project name in lookupRepoCatalogEntry", () => {
    const collisionCatalog: PortfolioCatalog = {
      ...SAMPLE_CATALOG,
      repositories: [
        {
          ...SAMPLE_CATALOG.repositories[0]!,
          name: "documentum",
          path: "/Users/adrianb/dev/other-documentum",
          domain: "01-fleet-and-harness",
        },
        {
          ...SAMPLE_CATALOG.repositories[2]!,
          name: "pentforge-documentum",
          path: "/Users/adrianb/dev/pentforge-documentum",
          domain: "02-pentforge-and-security",
        },
      ],
    };
    const matched = lookupRepoCatalogEntry(
      collisionCatalog,
      "documentum",
      "/Users/adrianb/dev/pentforge-documentum/",
    );
    expect(matched?.name).toBe("pentforge-documentum");
    expect(matched?.domain).toBe("02-pentforge-and-security");
  });
});

describe("orca-axi portfolio CLI command", () => {
  it("prints help for portfolio --help", async () => {
    const { output, exitCode } = await runCli(["portfolio", "--help"]);
    expect(exitCode).toBe(0);
    expect(output).toContain("usage: orca-axi portfolio");
    expect(output).toContain("--domain");
    expect(output).toContain("--tier");
  });

  it("falls back gracefully with exit 0 when portfolio-catalog.json is absent", async () => {
    process.env.ORCA_AXI_PORTFOLIO_CATALOG = join(dir, "missing-catalog.json");
    const { output, exitCode } = await runCli(["portfolio", "--json"]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(output) as {
      portfolio: { status: string; totals: { repositories: number } };
    };
    expect(parsed.portfolio.status).toBe("missing_catalog");
    expect(parsed.portfolio.totals.repositories).toBe(0);

    const toonFallback = await runCli(["portfolio"]);
    expect(toonFallback.exitCode).toBe(0);
    expect(toonFallback.output).toContain("missing_catalog");
  });

  it("emits TOON summary, --full repository rows, and filtered --json output", async () => {
    const catalogFile = join(dir, "portfolio-catalog.json");
    writeFileSync(catalogFile, JSON.stringify(SAMPLE_CATALOG));
    process.env.ORCA_AXI_PORTFOLIO_CATALOG = catalogFile;

    const toonRes = await runCli(["portfolio"]);
    expect(toonRes.exitCode).toBe(0);
    expect(toonRes.output).toContain("status: ok");
    expect(toonRes.output).toContain("01-fleet-and-harness");
    expect(toonRes.output).toContain("help[");

    const fullRes = await runCli(["portfolio", "--full"]);
    expect(fullRes.exitCode).toBe(0);
    expect(fullRes.output).toContain("craft-anything");
    expect(fullRes.output).toContain("P-OCD-70");

    const tierOnlyRes = await runCli(["portfolio", "--tier", "1", "--json"]);
    expect(tierOnlyRes.exitCode).toBe(0);
    const tierParsed = JSON.parse(tierOnlyRes.output) as {
      portfolio: {
        totals: { domains: number; repositories: number; tier1: number };
      };
    };
    expect(tierParsed.portfolio.totals.domains).toBe(2);
    expect(tierParsed.portfolio.totals.repositories).toBe(2);

    const jsonRes = await runCli(["portfolio", "--domain", "02", "--tier", "1", "--json"]);
    expect(jsonRes.exitCode).toBe(0);
    const parsed = JSON.parse(jsonRes.output) as {
      portfolio: {
        status: string;
        totals: { repositories: number; tier1: number };
        repositories: Array<{ name: string; linear_project_id: string | null }>;
      };
    };
    expect(parsed.portfolio.status).toBe("ok");
    expect(parsed.portfolio.totals.repositories).toBe(1);
    expect(parsed.portfolio.totals.tier1).toBe(1);
    expect(parsed.portfolio.repositories[0]?.name).toBe("pentforge-documentum");
  });

  it("exits 2 on unknown portfolio flag or bad --tier value", async () => {
    const catalogFile = join(dir, "portfolio-catalog.json");
    writeFileSync(catalogFile, JSON.stringify(SAMPLE_CATALOG));
    process.env.ORCA_AXI_PORTFOLIO_CATALOG = catalogFile;

    const badFlag = await runCli(["portfolio", "--bogus"]);
    expect(badFlag.exitCode).toBe(2);
    expect(badFlag.output).toContain("unknown flag --bogus");

    const badTier = await runCli(["portfolio", "--tier", "tier-99"]);
    expect(badTier.exitCode).toBe(2);
    expect(badTier.output).toContain("invalid --tier");
  });
});

describe("orca-axi projects --by-domain and --tier enrichment", () => {
  const fakeFleetReport: FleetAgentsReport = Object.freeze({
    generatedAt: "2026-11-12T07:40:00Z",
    localHost: "adi0",
    machines: Object.freeze([
      Object.freeze({ host: "adi0", reachable: true, agentCount: 2, workingCount: 2, durationMs: 10 }),
    ]),
    totals: Object.freeze({
      agents: 2,
      working: 2,
      idle: 0,
      bridged: 0,
      machinesOnline: 1,
      machinesTotal: 1,
      activeProjects: 2,
      harnesses: Object.freeze({ claude: 1, codex: 1 }),
    }),
    items: Object.freeze([
      Object.freeze({
        id: "adi0:101",
        host: "adi0",
        pid: 101,
        ppid: 1,
        tty: "ttys001",
        harness: "claude" as const,
        surface: "orca" as const,
        surfaces: Object.freeze(["orca" as const]),
        state: "working" as const,
        cpuPercent: 12.5,
        elapsed: "05:00",
        sessionId: "sess-doc",
        title: "Documentum auth",
        cwd: "/Users/adrianb/dev/pentforge-documentum",
        project: "pentforge-documentum",
        repoPath: "/Users/adrianb/dev/pentforge-documentum",
        worktreePath: "/Users/adrianb/dev/pentforge-documentum",
        branch: "feat/auth",
        linearIssue: "CYB-501",
        lastActivityAt: 1000,
        command: "claude",
      }),
      Object.freeze({
        id: "adi0:102",
        host: "adi0",
        pid: 102,
        ppid: 1,
        tty: "ttys002",
        harness: "codex" as const,
        surface: "tmux" as const,
        surfaces: Object.freeze(["tmux" as const]),
        state: "working" as const,
        cpuPercent: 8.0,
        elapsed: "03:00",
        sessionId: "sess-hex",
        title: "Hexforge audit",
        cwd: "/Users/adrianb/dev/hexforge",
        project: "hexforge",
        repoPath: "/Users/adrianb/dev/hexforge",
        worktreePath: "/Users/adrianb/dev/hexforge",
        branch: "main",
        linearIssue: null,
        lastActivityAt: 1000,
        command: "codex",
      }),
    ]),
    projects: Object.freeze([
      Object.freeze({
        project: "pentforge-documentum",
        repoPath: "/Users/adrianb/dev/pentforge-documentum",
        activeAgentCount: 1,
        workingCount: 1,
        hosts: Object.freeze(["adi0"]),
        harnesses: Object.freeze(["claude" as const]),
        linearIssues: Object.freeze(["CYB-501"]),
        worktrees: Object.freeze(["/Users/adrianb/dev/pentforge-documentum"]),
        docs: Object.freeze({ readme: true, roadmap: false, plans: true }),
        agents: Object.freeze([]),
      }),
      Object.freeze({
        project: "hexforge",
        repoPath: "/Users/adrianb/dev/hexforge",
        activeAgentCount: 1,
        workingCount: 1,
        hosts: Object.freeze(["adi0"]),
        harnesses: Object.freeze(["codex" as const]),
        linearIssues: Object.freeze([]),
        worktrees: Object.freeze(["/Users/adrianb/dev/hexforge"]),
        docs: Object.freeze({ readme: true, roadmap: false, plans: false }),
        agents: Object.freeze([]),
      }),
    ]),
  });

  it("groups active projects by domain and filters by --tier without mutating input", async () => {
    const catalogFile = join(dir, "portfolio-catalog.json");
    writeFileSync(catalogFile, JSON.stringify(SAMPLE_CATALOG));

    const outJson = await agentsCommand(
      ["--summary-by-project", "--by-domain", "--tier", "1", "--json"],
      {
        collect: async () => fakeFleetReport,
        loadCatalog: () => loadPortfolioCatalog({ catalogPath: catalogFile }),
      },
    );
    const parsed = JSON.parse(outJson) as {
      agents: {
        catalogStatus?: string;
        domains?: Array<{ domain: string; activeProjects: number; projectNames: string[] }>;
        projects: Array<{ project: string; domain?: string; tier?: string }>;
      };
    };
    expect(parsed.agents.catalogStatus).toBe("ok");
    expect(parsed.agents.projects).toHaveLength(1);
    expect(parsed.agents.projects[0]?.project).toBe("pentforge-documentum");
    expect(parsed.agents.projects[0]?.domain).toBe("02-pentforge-and-security");
    expect(parsed.agents.domains?.[0]?.domain).toBe("02-pentforge-and-security");
    expect(parsed.agents.domains?.[0]?.projectNames).toEqual(["pentforge-documentum"]);
  });

  it("surfaces catalogStatus=missing_catalog and preserves items when catalog is absent", async () => {
    const missingFile = join(dir, "absent.json");
    const outToon = await agentsCommand(
      ["--summary-by-project", "--by-domain", "--tier", "1"],
      {
        collect: async () => fakeFleetReport,
        loadCatalog: () => loadPortfolioCatalog({ catalogPath: missingFile }),
      },
    );
    expect(outToon).toContain("catalogStatus: missing_catalog");
    expect(outToon).toContain("unclassified");
    expect(outToon).toContain("pentforge-documentum");
    expect(outToon).toContain("hexforge");
  });
});
