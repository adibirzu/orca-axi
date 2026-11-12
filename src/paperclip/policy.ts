import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  type CustodySnapshot,
  type GuardDispatchDecision,
  type PaperclipOrgsConfig,
  PaperclipOrgsConfigSchema,
  type PaperclipOrgSpec,
  type PaperclipProjectSpec,
} from "./types.js";

export interface LoadOrgsConfigOptions {
  readonly configPath?: string;
  readonly homeDir?: string;
}

export interface ResolvedProjectGovernance {
  readonly org: PaperclipOrgSpec;
  readonly project: PaperclipProjectSpec;
}

export interface EvaluateCustodyInput {
  readonly issueId?: string | null;
  readonly branchName?: string | null;
  readonly custody?: CustodySnapshot;
}

export interface CustodyFenceVerdict {
  readonly fenced: boolean;
  readonly fencedBy: string | null;
  readonly reason: string | null;
}

export interface GuardDispatchRequest {
  readonly project: string;
  readonly host: string;
  readonly harness: string;
  readonly issueId?: string | null;
  readonly branchName?: string | null;
  readonly custody?: CustodySnapshot;
  readonly mcpAction?: "github.merge_pr" | "secrets.raw_export" | null;
}

function resolveBundledConfigPath(): string {
  const fromSrc = fileURLToPath(new URL("../../config/paperclip-orgs.json", import.meta.url));
  if (existsSync(fromSrc)) return fromSrc;
  return fileURLToPath(new URL("../../../config/paperclip-orgs.json", import.meta.url));
}

export function resolvePaperclipOrgsPath(options: LoadOrgsConfigOptions = {}): string {
  if (options.configPath) {
    return resolve(options.configPath);
  }
  const envPath = process.env.ORCA_AXI_PAPERCLIP_ORGS?.trim();
  if (envPath) {
    return resolve(envPath);
  }
  const home = options.homeDir ?? process.env.ORCA_AXI_HOME?.trim() ?? homedir();
  const userPath = join(home, ".config", "orca-axi", "paperclip-orgs.json");
  if (existsSync(userPath)) {
    return userPath;
  }
  return resolveBundledConfigPath();
}

function assertUniqueMappings(config: PaperclipOrgsConfig): void {
  const orgSlugs = new Set<string>();
  const initiatives = new Set<string>();
  const projectIds = new Set<string>();

  for (const org of config.organizations) {
    if (orgSlugs.has(org.slug)) {
      throw new Error(`Duplicate organization slug in paperclip-orgs.json: ${org.slug}`);
    }
    orgSlugs.add(org.slug);
    if (initiatives.has(org.initiativeId)) {
      throw new Error(`Duplicate Linear initiative mapping: ${org.initiativeId}`);
    }
    initiatives.add(org.initiativeId);

    for (const proj of org.projects) {
      if (projectIds.has(proj.id)) {
        throw new Error(`Duplicate project ID mapping: ${proj.id}`);
      }
      projectIds.add(proj.id);
    }
  }
}

export function loadPaperclipOrgsConfig(
  options: LoadOrgsConfigOptions = {},
): PaperclipOrgsConfig {
  const targetPath = resolvePaperclipOrgsPath(options);
  const raw = JSON.parse(readFileSync(targetPath, "utf8")) as unknown;
  const validated = PaperclipOrgsConfigSchema.parse(raw);
  assertUniqueMappings(validated);
  return validated;
}

function normalizeToken(value: string): string {
  return value.trim().toLowerCase();
}

export function resolveProjectGovernance(
  config: PaperclipOrgsConfig,
  query: string,
): ResolvedProjectGovernance | null {
  const q = normalizeToken(query);
  if (!q) return null;

  for (const org of config.organizations) {
    for (const project of org.projects) {
      const repoNames = project.repos.map((r) => normalizeToken(r));
      const repoBasenames = project.repos.map((r) => normalizeToken(r.split("/")[1] ?? r));
      if (
        normalizeToken(project.slug) === q ||
        normalizeToken(project.id) === q ||
        normalizeToken(project.linearUuid) === q ||
        normalizeToken(project.name) === q ||
        (project.primaryRepo && normalizeToken(project.primaryRepo) === q) ||
        repoNames.includes(q) ||
        repoBasenames.includes(q)
      ) {
        return { org, project };
      }
    }
  }
  return null;
}

export function extractCanonicalIssueId(rawIssue: string | null | undefined): string | null {
  if (!rawIssue) return null;
  const match = /\b((?:CYB|OCD)-\d+)\b/i.exec(rawIssue);
  return match ? match[1]!.toUpperCase() : rawIssue.trim().toUpperCase() || null;
}

export function evaluateCustodyFence(
  config: PaperclipOrgsConfig,
  input: EvaluateCustodyInput,
): CustodyFenceVerdict {
  const fences = config.globalGovernance.custodyFences;
  const hostOwner = input.custody?.reviewforgeHost ?? fences.reviewforgeHost;
  const branch = input.branchName?.trim() ?? "";

  if (branch) {
    for (const prefix of fences.fencedBranchPrefixes) {
      if (branch.toLowerCase().startsWith(prefix.toLowerCase())) {
        return {
          fenced: true,
          fencedBy: hostOwner,
          reason: `Branch '${branch}' matches external custody prefix '${prefix}' (${hostOwner})`,
        };
      }
    }
  }

  const issueId = extractCanonicalIssueId(input.issueId);
  if (!issueId) {
    return { fenced: false, fencedBy: null, reason: null };
  }

  const companionSet = new Set(
    [...fences.adi0CompanionIssues, ...(input.custody?.adi0CompanionIssues ?? [])].map((id) =>
      extractCanonicalIssueId(id) ?? id.toUpperCase(),
    ),
  );
  if (companionSet.has(issueId)) {
    return { fenced: false, fencedBy: null, reason: null };
  }

  const fencedSet = new Set(
    [...fences.fencedIssues, ...(input.custody?.fencedIssues ?? [])].map(
      (id) => extractCanonicalIssueId(id) ?? id.toUpperCase(),
    ),
  );
  if (fencedSet.has(issueId)) {
    return {
      fenced: true,
      fencedBy: hostOwner,
      reason: `Issue ${issueId} is under active ${hostOwner} custody`,
    };
  }

  if (issueId.startsWith(`${fences.linearTeamFence.toUpperCase()}-`)) {
    return {
      fenced: true,
      fencedBy: hostOwner,
      reason: `Linear team ${fences.linearTeamFence} issue ${issueId} is fenced to ${hostOwner}`,
    };
  }

  return { fenced: false, fencedBy: null, reason: null };
}

function isAllowedExecutionHost(config: PaperclipOrgsConfig, rawHost: string): boolean {
  const normalized = normalizeToken(rawHost).replace(/\.local$/, "");
  if (!normalized) return false;
  const forbidden = new Set(config.globalGovernance.forbiddenExecutionHosts.map(normalizeToken));
  if (forbidden.has(normalized)) {
    return false;
  }
  const allowed = new Set(config.globalGovernance.allowedExecutionHosts.map(normalizeToken));
  return allowed.has(normalized);
}

export function guardDispatch(
  config: PaperclipOrgsConfig,
  request: GuardDispatchRequest,
): GuardDispatchDecision {
  const host = request.host.trim();
  const harness = normalizeToken(request.harness);
  const resolved = resolveProjectGovernance(config, request.project);
  const mcpGovernance = resolved?.org.governance.mcpGovernance ?? config.globalGovernance.mcpGovernance;

  if (request.mcpAction === "github.merge_pr" && !mcpGovernance.githubMergePr) {
    return {
      allowed: false,
      code: "FORBIDDEN_MCP_ACTION",
      reason: "MCP action 'github.merge_pr' is hard-blocked by governance policy",
      orgSlug: resolved?.org.slug ?? null,
      projectId: resolved?.project.id ?? null,
      projectSlug: resolved?.project.slug ?? null,
      executionTarget: config.globalGovernance.executionTarget,
      host,
      harness,
      mcpGovernance,
      fencedBy: null,
    };
  }

  if (request.mcpAction === "secrets.raw_export" && !mcpGovernance.secretsRawExport) {
    return {
      allowed: false,
      code: "FORBIDDEN_MCP_ACTION",
      reason: "MCP action 'secrets.raw_export' is hard-blocked by governance policy",
      orgSlug: resolved?.org.slug ?? null,
      projectId: resolved?.project.id ?? null,
      projectSlug: resolved?.project.slug ?? null,
      executionTarget: config.globalGovernance.executionTarget,
      host,
      harness,
      mcpGovernance,
      fencedBy: null,
    };
  }

  if (!isAllowedExecutionHost(config, host)) {
    return {
      allowed: false,
      code: "FORBIDDEN_EXECUTION_HOST",
      reason: `Host '${host}' is forbidden from coding execution (executionTarget=${config.globalGovernance.executionTarget}, vpsLocalCodeExec=false)`,
      orgSlug: resolved?.org.slug ?? null,
      projectId: resolved?.project.id ?? null,
      projectSlug: resolved?.project.slug ?? null,
      executionTarget: config.globalGovernance.executionTarget,
      host,
      harness,
      mcpGovernance,
      fencedBy: null,
    };
  }

  const fence = evaluateCustodyFence(config, {
    issueId: request.issueId,
    branchName: request.branchName,
    custody: request.custody,
  });
  if (fence.fenced) {
    return {
      allowed: false,
      code: "CUSTODY_FENCED",
      reason: fence.reason ?? "Fenced by external custody policy",
      orgSlug: resolved?.org.slug ?? null,
      projectId: resolved?.project.id ?? null,
      projectSlug: resolved?.project.slug ?? null,
      executionTarget: config.globalGovernance.executionTarget,
      host,
      harness,
      mcpGovernance,
      fencedBy: fence.fencedBy,
    };
  }

  if (!resolved) {
    return {
      allowed: false,
      code: "UNKNOWN_PROJECT",
      reason: `Project '${request.project}' is not mapped in paperclip-orgs.json`,
      orgSlug: null,
      projectId: null,
      projectSlug: null,
      executionTarget: config.globalGovernance.executionTarget,
      host,
      harness,
      mcpGovernance,
      fencedBy: null,
    };
  }

  const blockedSet = new Set(
    [
      ...resolved.org.governance.blockedHarnesses,
      ...(resolved.project.blockedHarnesses ?? []),
    ].map(normalizeToken),
  );
  const allowedList = resolved.project.allowedHarnesses ?? resolved.org.governance.allowedHarnesses;
  const allowedSet = new Set(allowedList.map(normalizeToken));

  if (blockedSet.has(harness) || !allowedSet.has(harness)) {
    return {
      allowed: false,
      code: "FORBIDDEN_HARNESS",
      reason: `Harness '${harness}' is blocked on ${resolved.project.slug} (${resolved.org.slug}); allowed: ${Array.from(allowedSet).join(", ")}`,
      orgSlug: resolved.org.slug,
      projectId: resolved.project.id,
      projectSlug: resolved.project.slug,
      executionTarget: resolved.org.governance.executionTarget,
      host,
      harness,
      mcpGovernance,
      fencedBy: null,
    };
  }

  return {
    allowed: true,
    code: "ALLOWED",
    reason: `Allowed on ${host} (${resolved.org.slug}/${resolved.project.slug}) with harness '${harness}'`,
    orgSlug: resolved.org.slug,
    projectId: resolved.project.id,
    projectSlug: resolved.project.slug,
    executionTarget: resolved.org.governance.executionTarget,
    host,
    harness,
    mcpGovernance,
    fencedBy: null,
  };
}
