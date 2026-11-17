import { AxiError } from "axi-sdk-js";

import { parseArgs, type FlagSpec } from "../args.js";
import {
  filterPortfolioRepositories,
  loadPortfolioCatalog,
  normalizeTierFilter,
  summarizePortfolioDomains,
  type LoadCatalogOptions,
} from "../portfolio/catalog.js";
import { collapseHome, helpBlock, toon } from "../render.js";

const PORTFOLIO_FLAGS: FlagSpec[] = [
  { name: "--domain", value: "domain", description: "Filter by domain code (01..06), key, or Linear label" },
  { name: "--tier", value: "tier", description: "Filter by tier (1|2|3 or tier-1-primary|tier-2-active|tier-3-reference)" },
  { name: "--project", value: "query", description: "Filter by repo name or Linear project ID/name/slug" },
  { name: "--stack", value: "stack", description: "Filter by primary stack (e.g. typescript, python, rust, go)" },
  { name: "--full", description: "Include full repository table in TOON output even without filters" },
  { name: "--json", description: "Emit machine-readable JSON" },
];

export const PORTFOLIO_HELP = `usage: orca-axi portfolio [--domain <domain>] [--tier <tier>] [--project <query>] [--stack <stack>] [--full] [--json]
description:
  Inspect the workstation repository & Linear initiative catalog stored at
  ~/.config/orca-axi/portfolio-catalog.json (override via ORCA_AXI_PORTFOLIO_CATALOG).
  Falls back gracefully (exit 0, status=missing_catalog) when absent.
outputs:
  TOON summary: status, primaryStation, totals, domains[] (plus repositories[] with filters or --full)
  --json  machine-readable {portfolio: ...} envelope
flags[${PORTFOLIO_FLAGS.length + 1}]:
${PORTFOLIO_FLAGS.map((f) => `  ${f.name}${f.value ? ` <${f.value}>` : ""}`).join(", ")}, --help
examples:
  orca-axi portfolio
  orca-axi portfolio --domain 02 --tier 1
  orca-axi portfolio --project P-CYB-71 --json
  orca-axi portfolio --stack typescript --full
`;

export async function portfolioCommand(
  args: string[],
  loadOptions: LoadCatalogOptions = {},
): Promise<string> {
  if (args[0] === "--help" || args[0] === "-h") {
    return PORTFOLIO_HELP;
  }

  const { booleans, values } = parseArgs("portfolio", args, PORTFOLIO_FLAGS);
  const rawTier = values.get("--tier");
  if (rawTier !== undefined && normalizeTierFilter(rawTier) === null) {
    throw new AxiError(`invalid --tier value "${rawTier}"`, "VALIDATION_ERROR", [
      "Valid --tier values: 1, 2, 3, tier-1-primary, tier-2-active, tier-3-reference",
      "Run `orca-axi portfolio --help` for examples",
    ]);
  }

  const domainFilter = values.get("--domain") ?? null;
  const projectFilter = values.get("--project") ?? null;
  const stackFilter = values.get("--stack") ?? null;
  const full = booleans.has("--full");
  const json = booleans.has("--json");

  const loaded = loadPortfolioCatalog(loadOptions);
  if (loaded.status !== "ok" || !loaded.catalog) {
    const fallbackPayload = {
      status: loaded.status,
      catalogPath: collapseHome(loaded.catalogPath),
      ...(loaded.error ? { error: loaded.error } : {}),
      totals: {
        domains: 0,
        repositories: 0,
        tier1: 0,
        tier2: 0,
        tier3: 0,
        mappedLinearProjects: 0,
      },
      domains: [],
      repositories: [],
    };
    if (json) {
      return JSON.stringify({ portfolio: fallbackPayload }, null, 2);
    }
    return toon(
      { portfolio: fallbackPayload },
      helpBlock([
        `Create ${collapseHome(loaded.catalogPath)} (schemaVersion: portfolio-catalog.v1) to enable domain views`,
        "Run `orca-axi projects --all-machines` to inspect live running fleet agents",
      ]),
    );
  }

  const catalog = loaded.catalog;
  const filteredRepos = filterPortfolioRepositories(catalog, {
    domain: domainFilter,
    tier: rawTier ?? null,
    project: projectFilter,
    stack: stackFilter,
  });

  const hasFilter = Boolean(domainFilter || rawTier || projectFilter || stackFilter);
  const allDomainSummaries = summarizePortfolioDomains(catalog.domains, filteredRepos);
  const domainSummaries = hasFilter
    ? allDomainSummaries.filter((d) => d.repoCount > 0)
    : allDomainSummaries;

  const mappedLinearProjects = new Set(
    filteredRepos
      .map((r) => r.linear_project_id ?? r.linear_project_slug ?? r.linear_project_name)
      .filter((x): x is string => Boolean(x)),
  ).size;

  const totals = {
    domains: domainSummaries.length,
    repositories: filteredRepos.length,
    tier1: filteredRepos.filter((r) => r.tier === "tier-1-primary").length,
    tier2: filteredRepos.filter((r) => r.tier === "tier-2-active").length,
    tier3: filteredRepos.filter((r) => r.tier === "tier-3-reference").length,
    mappedLinearProjects,
  };

  if (json) {
    return JSON.stringify(
      {
        portfolio: {
          status: "ok",
          schemaVersion: catalog.schemaVersion,
          primaryStation: catalog.primary_station,
          catalogPath: collapseHome(loaded.catalogPath),
          totals,
          domains: domainSummaries.map((d) => ({
            ...d,
            workspaceDir: collapseHome(d.workspaceDir),
          })),
          repositories: filteredRepos.map((r) => ({
            ...r,
            path: collapseHome(r.path),
          })),
        },
      },
      null,
      2,
    );
  }

  const showRepos = full || hasFilter;

  const compactPortfolio = {
    portfolio: {
      status: "ok",
      primaryStation: catalog.primary_station,
      catalogPath: collapseHome(loaded.catalogPath),
      totals,
      domains: domainSummaries.map((d) => ({
        domain: d.key,
        initiative: d.initiativeId,
        label: d.label,
        repos: d.repoCount,
        tiers: `t1=${d.tier1Count},t2=${d.tier2Count},t3=${d.tier3Count}`,
        workspace: collapseHome(d.workspaceDir),
        topRepos: d.topRepos.join(","),
      })),
      ...(showRepos
        ? {
            repositories: filteredRepos.map((r) => ({
              name: r.name,
              domain: r.domain,
              tier: r.tier,
              linearProject: r.linear_project_id ?? "-",
              stack: r.primary_stack,
              lastCommit: r.last_commit_at ? r.last_commit_at.slice(0, 10) : "-",
              path: collapseHome(r.path),
            })),
          }
        : {}),
    },
  };

  return toon(
    compactPortfolio,
    helpBlock([
      "Run `orca-axi portfolio --domain 01 --tier 1` to list Tier-1 repos in a domain",
      "Run `orca-axi projects --by-domain --all-machines` to group active fleet agents by domain",
    ]),
  );
}
