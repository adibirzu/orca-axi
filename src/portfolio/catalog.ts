import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

export type PortfolioTier = "tier-1-primary" | "tier-2-active" | "tier-3-reference";

export interface PortfolioDomain {
  readonly key: string;
  readonly code: string;
  readonly name: string;
  readonly label: string;
  readonly initiative_id: string;
  readonly initiative_uuid?: string;
  readonly initiative_url: string;
  readonly workspace_dir: string;
}

export interface PortfolioRepository {
  readonly name: string;
  readonly path: string;
  readonly remote: string | null;
  readonly domain: string;
  readonly tier: PortfolioTier;
  readonly linear_project_id: string | null;
  readonly linear_project_slug: string | null;
  readonly linear_project_name: string | null;
  readonly last_commit_at: string | null;
  readonly primary_stack: string;
}

export interface PortfolioCatalog {
  readonly schemaVersion: "portfolio-catalog.v1";
  readonly generatedAt?: string;
  readonly primary_station: string;
  readonly dev_root?: string;
  readonly workspaces_root?: string;
  readonly domains: readonly PortfolioDomain[];
  readonly repositories: readonly PortfolioRepository[];
}

export type CatalogLoadStatus = "ok" | "missing_catalog" | "invalid_catalog";

export interface CatalogLoadResult {
  readonly status: CatalogLoadStatus;
  readonly catalogPath: string;
  readonly catalog: PortfolioCatalog | null;
  readonly error?: string;
}

export interface LoadCatalogOptions {
  readonly catalogPath?: string;
  readonly homeDir?: string;
}

export interface PortfolioFilterOptions {
  readonly domain?: string | null;
  readonly tier?: string | null;
  readonly project?: string | null;
  readonly stack?: string | null;
}

export interface PortfolioDomainSummary {
  readonly key: string;
  readonly code: string;
  readonly name: string;
  readonly label: string;
  readonly initiativeId: string;
  readonly initiativeUrl: string;
  readonly workspaceDir: string;
  readonly repoCount: number;
  readonly tier1Count: number;
  readonly tier2Count: number;
  readonly tier3Count: number;
  readonly linearProjects: readonly string[];
  readonly topRepos: readonly string[];
}

const VALID_TIERS = new Set<PortfolioTier>([
  "tier-1-primary",
  "tier-2-active",
  "tier-3-reference",
]);

/** Strip userinfo/tokens from HTTP(S)/SSH git remote URLs before exposing in output. */
export function sanitizeRemoteUrl(remote: string | null | undefined): string | null {
  if (!remote || typeof remote !== "string") return null;
  const trimmed = remote.trim();
  if (!trimmed) return null;
  try {
    if (/^https?:\/\//i.test(trimmed)) {
      const parsed = new URL(trimmed);
      parsed.username = "";
      parsed.password = "";
      return parsed.toString();
    }
  } catch {
    // Fallback regex redaction if URL constructor rejects unusual syntax
  }
  return trimmed.replace(/^(https?:\/\/)[^/@\s]+@/i, "$1");
}

function normalizeFsPath(p: string): string {
  return p.length > 1 ? p.replace(/\/+$/, "") : p;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function resolveCatalogPath(options: LoadCatalogOptions = {}): string {
  if (options.catalogPath) {
    return resolve(options.catalogPath);
  }
  const envCatalog = process.env.ORCA_AXI_PORTFOLIO_CATALOG?.trim();
  if (envCatalog) {
    return resolve(envCatalog);
  }
  const effectiveHome =
    options.homeDir ?? process.env.ORCA_AXI_HOME?.trim() ?? homedir();
  return join(effectiveHome, ".config", "orca-axi", "portfolio-catalog.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function loadPortfolioCatalog(options: LoadCatalogOptions = {}): CatalogLoadResult {
  const catalogPath = resolveCatalogPath(options);

  let rawText: string;
  try {
    rawText = readFileSync(catalogPath, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") {
      return {
        status: "missing_catalog",
        catalogPath,
        catalog: null,
      };
    }
    return {
      status: "invalid_catalog",
      catalogPath,
      catalog: null,
      error: `Failed to read catalog: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (err) {
    return {
      status: "invalid_catalog",
      catalogPath,
      catalog: null,
      error: `Invalid JSON in portfolio catalog: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (
    !isRecord(parsed) ||
    parsed.schemaVersion !== "portfolio-catalog.v1" ||
    typeof parsed.primary_station !== "string" ||
    !Array.isArray(parsed.domains) ||
    !Array.isArray(parsed.repositories)
  ) {
    return {
      status: "invalid_catalog",
      catalogPath,
      catalog: null,
      error: "Expected schemaVersion 'portfolio-catalog.v1' with primary_station, domains[], and repositories[]",
    };
  }

  const domains: PortfolioDomain[] = [];
  for (const d of parsed.domains) {
    if (!isRecord(d)) continue;
    const key = nonEmptyString(d.key);
    const name = nonEmptyString(d.name);
    if (!key || !name) {
      return {
        status: "invalid_catalog",
        catalogPath,
        catalog: null,
        error: "Every domain entry must have non-empty string key and name",
      };
    }
    domains.push({
      key,
      code: nonEmptyString(d.code) ?? "",
      name,
      label: nonEmptyString(d.label) ?? "",
      initiative_id: nonEmptyString(d.initiative_id) ?? "",
      ...(typeof d.initiative_uuid === "string" ? { initiative_uuid: d.initiative_uuid } : {}),
      initiative_url: nonEmptyString(d.initiative_url) ?? "",
      workspace_dir: nonEmptyString(d.workspace_dir) ?? "",
    });
  }

  const repositories: PortfolioRepository[] = [];
  for (const r of parsed.repositories) {
    if (!isRecord(r)) continue;
    const name = nonEmptyString(r.name);
    const path = nonEmptyString(r.path);
    const rawTier = nonEmptyString(r.tier) as PortfolioTier | null;
    if (!name || !path || !rawTier || !VALID_TIERS.has(rawTier)) {
      return {
        status: "invalid_catalog",
        catalogPath,
        catalog: null,
        error: `Invalid repository entry "${String(r.name ?? "")}": requires non-empty name, path, and valid tier`,
      };
    }
    repositories.push({
      name,
      path: normalizeFsPath(path),
      remote: sanitizeRemoteUrl(typeof r.remote === "string" ? r.remote : null),
      domain: nonEmptyString(r.domain) ?? "unclassified",
      tier: rawTier,
      linear_project_id: nonEmptyString(r.linear_project_id),
      linear_project_slug: nonEmptyString(r.linear_project_slug),
      linear_project_name: nonEmptyString(r.linear_project_name),
      last_commit_at: nonEmptyString(r.last_commit_at),
      primary_stack: nonEmptyString(r.primary_stack) ?? "misc",
    });
  }

  return {
    status: "ok",
    catalogPath,
    catalog: {
      schemaVersion: "portfolio-catalog.v1",
      ...(typeof parsed.generatedAt === "string" ? { generatedAt: parsed.generatedAt } : {}),
      primary_station: parsed.primary_station,
      ...(typeof parsed.dev_root === "string" ? { dev_root: parsed.dev_root } : {}),
      ...(typeof parsed.workspaces_root === "string" ? { workspaces_root: parsed.workspaces_root } : {}),
      domains,
      repositories,
    },
  };
}

export function normalizeTierFilter(raw: string | null | undefined): PortfolioTier | null {
  if (!raw) return null;
  const cleaned = raw.trim().toLowerCase();
  if (!cleaned) return null;
  if (cleaned === "1" || cleaned === "tier-1" || cleaned === "tier:1-core" || cleaned === "tier-1-primary") {
    return "tier-1-primary";
  }
  if (cleaned === "2" || cleaned === "tier-2" || cleaned === "tier:2-active" || cleaned === "tier-2-active") {
    return "tier-2-active";
  }
  if (cleaned === "3" || cleaned === "tier-3" || cleaned === "tier:3-incubating" || cleaned === "tier-3-reference") {
    return "tier-3-reference";
  }
  return null;
}

export function matchesDomainQuery(
  repoDomain: string,
  domainByKey: ReadonlyMap<string, PortfolioDomain>,
  query: string,
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;

  const meta = domainByKey.get(repoDomain);

  // Pure numeric shorthand ("1".."9" or "01".."09"): match exact 2-digit domain code only
  if (/^\d{1,2}$/.test(q)) {
    const padded = q.padStart(2, "0");
    if (padded === "00") return false;
    return meta?.code.toLowerCase() === padded;
  }

  const lowerKey = repoDomain.toLowerCase();
  if (
    lowerKey === q ||
    meta?.code.toLowerCase() === q ||
    meta?.label.toLowerCase() === q ||
    meta?.initiative_id.toLowerCase() === q
  ) {
    return true;
  }

  if (q.length < 3) {
    return false;
  }

  return (
    lowerKey.includes(q) ||
    Boolean(meta?.label.toLowerCase().includes(q)) ||
    Boolean(meta?.name.toLowerCase().includes(q))
  );
}

export function filterPortfolioRepositories(
  catalog: PortfolioCatalog,
  filters: PortfolioFilterOptions,
): PortfolioRepository[] {
  const domainByKey = new Map(catalog.domains.map((d) => [d.key, d]));
  const normalizedTier = normalizeTierFilter(filters.tier);
  const projQuery = filters.project?.trim().toLowerCase() ?? "";
  const stackQuery = filters.stack?.trim().toLowerCase() ?? "";
  const domainQuery = filters.domain?.trim() ?? "";

  return catalog.repositories.filter((repo) => {
    if (domainQuery && !matchesDomainQuery(repo.domain, domainByKey, domainQuery)) {
      return false;
    }
    if (normalizedTier && repo.tier !== normalizedTier) {
      return false;
    }
    if (projQuery) {
      const haystacks = [
        repo.name,
        repo.linear_project_id ?? "",
        repo.linear_project_name ?? "",
        repo.linear_project_slug ?? "",
      ].map((s) => s.toLowerCase());
      if (!haystacks.some((h) => h.includes(projQuery))) {
        return false;
      }
    }
    if (stackQuery && !repo.primary_stack.toLowerCase().includes(stackQuery)) {
      return false;
    }
    return true;
  });
}

function buildDomainSummary(
  domain: PortfolioDomain,
  inDomain: readonly PortfolioRepository[],
): PortfolioDomainSummary {
  const linearProjects = Array.from(
    new Set(
      inDomain
        .map((r) =>
          r.linear_project_id && r.linear_project_name
            ? `${r.linear_project_id} (${r.linear_project_name})`
            : (r.linear_project_id ?? r.linear_project_name),
        )
        .filter((x): x is string => Boolean(x)),
    ),
  ).sort();

  const topRepos = [...inDomain]
    .sort((a, b) => a.tier.localeCompare(b.tier) || a.name.localeCompare(b.name))
    .slice(0, 6)
    .map((r) => r.name);

  return {
    key: domain.key,
    code: domain.code,
    name: domain.name,
    label: domain.label,
    initiativeId: domain.initiative_id,
    initiativeUrl: domain.initiative_url,
    workspaceDir: domain.workspace_dir,
    repoCount: inDomain.length,
    tier1Count: inDomain.filter((r) => r.tier === "tier-1-primary").length,
    tier2Count: inDomain.filter((r) => r.tier === "tier-2-active").length,
    tier3Count: inDomain.filter((r) => r.tier === "tier-3-reference").length,
    linearProjects,
    topRepos,
  };
}

export function summarizePortfolioDomains(
  domains: readonly PortfolioDomain[],
  repositories: readonly PortfolioRepository[],
): PortfolioDomainSummary[] {
  const knownKeys = new Set(domains.map((d) => d.key));
  const summaries = domains.map((domain) =>
    buildDomainSummary(
      domain,
      repositories.filter((r) => r.domain === domain.key),
    ),
  );

  const orphans = repositories.filter((r) => !knownKeys.has(r.domain));
  if (orphans.length > 0) {
    summaries.push(
      buildDomainSummary(
        {
          key: "unclassified",
          code: "99",
          name: "Unclassified Repositories",
          label: "domain:unclassified",
          initiative_id: "-",
          initiative_url: "",
          workspace_dir: "",
        },
        orphans,
      ),
    );
  }

  return summaries;
}

export function lookupRepoCatalogEntry(
  catalog: PortfolioCatalog | null,
  projectName: string,
  repoPath: string | null,
): PortfolioRepository | undefined {
  if (!catalog) return undefined;

  if (repoPath) {
    const normTarget = normalizeFsPath(repoPath);
    const exactPathMatch = catalog.repositories.find((r) => normalizeFsPath(r.path) === normTarget);
    if (exactPathMatch) return exactPathMatch;
  }

  const lowerProj = projectName.trim().toLowerCase();
  if (lowerProj) {
    const nameMatch = catalog.repositories.find((r) => r.name.toLowerCase() === lowerProj);
    if (nameMatch) return nameMatch;
  }

  if (repoPath) {
    const baseFromPath = basename(normalizeFsPath(repoPath)).toLowerCase();
    if (baseFromPath) {
      return catalog.repositories.find((r) => r.name.toLowerCase() === baseFromPath);
    }
  }

  return undefined;
}
