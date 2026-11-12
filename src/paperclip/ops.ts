import { loadBoardAuthConfig } from "./client.js";
import { loadLedger, resolveLedgerPath, saveLedgerAtomic, upsertLedgerEntry } from "./ledger.js";
import { type PaperclipCliDeps, resolveDepsClient } from "./ops-workflow.js";
import { loadPaperclipOrgsConfig, resolvePaperclipOrgsPath } from "./policy.js";
import { reconcileFourWay } from "./reconciler.js";
import {
  fetchGitHubPrsLive,
  fetchLinearIssuesLive,
  loadCustodySnapshotLive,
  loadFirstMateTasks,
  loadInstanceMap,
  saveInstanceMapAtomic,
  updateLinearIssueStateLive,
} from "./sources.js";
import type {
  PaperclipCompany,
  PaperclipIssue,
  PaperclipIssueStatus,
  PaperclipOrgInstanceEntry,
  SyncLedgerEntry,
  SyncPlan,
} from "./types.js";

export {
  type PaperclipCliDeps,
  runClaimOp,
  runGuardDispatchOp,
  runReportPrOp,
  runWatchEventsOp,
} from "./ops-workflow.js";

function matchExistingCompany(
  companies: readonly PaperclipCompany[],
  slug: string,
  name: string,
  mappedId?: string,
): PaperclipCompany | undefined {
  if (mappedId) {
    const byId = companies.find((c) => c.id === mappedId);
    if (byId) return byId;
  }
  const slugMarker = `slug:${slug}`.toLowerCase();
  return companies.find(
    (c) =>
      c.name.trim().toLowerCase() === name.trim().toLowerCase() ||
      Boolean(c.description?.toLowerCase().includes(slugMarker)),
  );
}

export async function runDoctorOp(deps: PaperclipCliDeps): Promise<Record<string, unknown>> {
  const configPath = resolvePaperclipOrgsPath({ configPath: deps.configPath });
  const config = loadPaperclipOrgsConfig({ configPath });
  const auth = loadBoardAuthConfig({
    boardEnvPath: deps.boardEnvPath ?? config.controlPlane.boardEnvPath,
  });
  const ledgerPath = resolveLedgerPath({ ledgerPath: deps.ledgerPath, fmHome: deps.fmHome });
  const ledger = loadLedger({ ledgerPath, fmHome: deps.fmHome });
  const instanceMap = loadInstanceMap(deps.instanceMapPath ?? config.controlPlane.instanceMapPath);
  const client = resolveDepsClient(deps, config);

  let apiHealth: Record<string, unknown>;
  let liveCompaniesCount: number | null = null;
  try {
    const h = await client.health();
    const cos = await client.listCompanies();
    liveCompaniesCount = cos.length;
    apiHealth = { reachable: true, ...h };
  } catch (err) {
    apiHealth = {
      reachable: false,
      status: "unreachable",
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const projectsCount = config.organizations.reduce((acc, o) => acc + o.projects.length, 0);
  return {
    configPath,
    organizationsCount: config.organizations.length,
    projectsCount,
    executionTarget: config.globalGovernance.executionTarget,
    mcpGovernance: config.globalGovernance.mcpGovernance,
    boardAuth: {
      boardEnvPath: auth.boardEnvPath,
      boardEnvPresent: auth.boardEnvPresent,
      primaryBase: auth.primaryBase,
      standbyBase: auth.standbyBase,
      hasBearerToken: Boolean(auth.bearerToken),
      hasCookie: Boolean(auth.cookieHeader),
    },
    ledger: {
      path: ledgerPath,
      entriesCount: Object.keys(ledger.entries).length,
      activityCursor: ledger.activityCursor ?? null,
    },
    mappedInstancesCount: Object.keys(instanceMap.organizations).length,
    liveCompaniesCount,
    apiHealth,
  };
}

export async function runOrgsBootstrapOp(
  deps: PaperclipCliDeps,
  options: { readonly apply: boolean },
): Promise<Record<string, unknown>> {
  const now = deps.now?.() ?? new Date().toISOString();
  const config = loadPaperclipOrgsConfig({ configPath: deps.configPath });
  const mapPath = deps.instanceMapPath ?? config.controlPlane.instanceMapPath;
  const existingMap = loadInstanceMap(mapPath);
  const client = resolveDepsClient(deps, config);
  const companies = await client.listCompanies();

  const nextOrgs: Record<string, PaperclipOrgInstanceEntry> = { ...existingMap.organizations };
  let plannedOrgsToCreate = 0;
  let plannedProjectsToCreate = 0;
  const orgReports: Array<Record<string, unknown>> = [];

  for (const orgSpec of config.organizations) {
    const prior = existingMap.organizations[orgSpec.slug];
    const matchedCo = matchExistingCompany(
      companies,
      orgSpec.slug,
      orgSpec.name,
      prior?.companyId ?? orgSpec.companyId,
    );
    let companyId = matchedCo?.id ?? null;

    if (!matchedCo) {
      plannedOrgsToCreate += 1;
      if (options.apply) {
        const created = await client.createCompany({
          name: orgSpec.name,
          description: `slug:${orgSpec.slug} | initiative:${orgSpec.initiativeId} | target:${orgSpec.governance.executionTarget}`,
          budgetMonthlyCents: orgSpec.budgetMonthlyCents,
        });
        companyId = created.id;
      }
    }

    const existingProjects = companyId ? await client.listProjects(companyId) : [];
    const projectsBySlug: Record<string, string> = { ...(prior?.projectsBySlug ?? {}) };

    for (const projSpec of orgSpec.projects) {
      const matchedProj = existingProjects.find(
        (p) =>
          p.id === projectsBySlug[projSpec.slug] ||
          p.name.trim().toLowerCase() === projSpec.name.trim().toLowerCase() ||
          p.name.trim().toLowerCase() === projSpec.slug.toLowerCase(),
      );
      if (matchedProj) {
        projectsBySlug[projSpec.slug] = matchedProj.id;
      } else {
        plannedProjectsToCreate += 1;
        if (options.apply && companyId) {
          const repoUrl = projSpec.primaryRepo ? `https://github.com/${projSpec.primaryRepo}` : null;
          const createdProj = await client.createProject(companyId, {
            name: projSpec.name,
            description: `${projSpec.id} (${projSpec.slug})`,
            repoUrl,
          });
          projectsBySlug[projSpec.slug] = createdProj.id;
        }
      }
    }

    if (companyId) nextOrgs[orgSpec.slug] = { companyId, projectsBySlug };
    orgReports.push({
      slug: orgSpec.slug,
      companyId,
      status: matchedCo ? "existing" : options.apply ? "created" : "planned",
      projectsCount: orgSpec.projects.length,
    });
  }

  if (options.apply) {
    saveInstanceMapAtomic(
      { schemaVersion: "paperclip-instance.v1", updatedAt: now, organizations: nextOrgs },
      mapPath,
    );
  }

  return {
    mode: options.apply ? "apply" : "dry-run",
    plannedOrgsToCreate,
    plannedProjectsToCreate,
    organizations: orgReports,
  };
}

function buildLedgerEntryFromMutation(
  mut: SyncPlan["mutations"][number],
  paperclipIssueId: string,
  now: string,
): SyncLedgerEntry {
  return {
    linearIdentifier: mut.linearIdentifier,
    linearIssueUuid: mut.linearIssueUuid,
    orgSlug: mut.orgSlug,
    paperclipCompanyId: mut.paperclipCompanyId!,
    ...(mut.paperclipProjectId ? { paperclipProjectId: mut.paperclipProjectId } : {}),
    paperclipIssueId,
    ...(mut.fmTaskId ? { fmTaskId: mut.fmTaskId } : {}),
    ...(mut.githubPrUrl ? { githubPrUrl: mut.githubPrUrl } : {}),
    ...(mut.ciState ? { ciState: mut.ciState } : {}),
    lastPaperclipStatus: mut.targetStatus as PaperclipIssueStatus,
    contentHash: mut.contentHash,
    ...(mut.fencedBy ? { fencedBy: mut.fencedBy } : {}),
    updatedAt: now,
  };
}

export async function runSyncOp(
  deps: PaperclipCliDeps,
  options: {
    readonly apply: boolean;
    readonly project?: string | null;
    readonly initiative?: string | null;
    readonly limit?: number | null;
  },
): Promise<SyncPlan & { readonly mode: string; readonly appliedCount: number }> {
  const now = deps.now?.() ?? new Date().toISOString();
  const config = loadPaperclipOrgsConfig({ configPath: deps.configPath });
  const fmHome = deps.fmHome ?? process.env.FM_HOME ?? "/Users/adrianb/dev/firstmate";
  const instanceMap = loadInstanceMap(deps.instanceMapPath ?? config.controlPlane.instanceMapPath);
  const ledger = loadLedger({ ledgerPath: deps.ledgerPath, fmHome });
  const client = resolveDepsClient(deps, config);

  const linearIssues = await (deps.fetchLinearIssues ?? fetchLinearIssuesLive)(config);
  const allRepos = config.organizations.flatMap((o) => o.projects.flatMap((p) => p.repos));
  const githubPrs = await (deps.fetchGitHubPrs ?? fetchGitHubPrsLive)(allRepos);
  const fmTasks = (deps.loadFirstMateTasks ?? loadFirstMateTasks)(fmHome);
  const custody = await (deps.loadCustodySnapshot ?? loadCustodySnapshotLive)(config);

  const paperclipIssuesByOrg: Record<string, readonly PaperclipIssue[]> = {};
  for (const [orgSlug, entry] of Object.entries(instanceMap.organizations)) {
    paperclipIssuesByOrg[orgSlug] = await client.listIssues(entry.companyId);
  }

  const plan = reconcileFourWay({
    orgsConfig: config,
    orgCompanyMap: instanceMap.organizations,
    linearIssues,
    paperclipIssuesByOrg,
    githubPrs,
    fmTasks,
    custody,
    ledger,
    filters: { project: options.project, initiative: options.initiative, limit: options.limit },
    now,
  });

  if (!options.apply) return { ...plan, mode: "dry-run", appliedCount: 0 };

  let nextLedger = ledger;
  let appliedCount = 0;
  const updateLinear = deps.updateLinearIssueState ?? updateLinearIssueStateLive;

  for (const mut of plan.mutations) {
    if (mut.target === "linear") {
      await updateLinear(mut.linearIssueUuid, mut.targetStatus, config.controlPlane.linearTeam.uuid);
      appliedCount += 1;
    } else if (mut.action === "create" && mut.paperclipCompanyId && mut.title) {
      const created = await client.createIssue(mut.paperclipCompanyId, {
        title: mut.title,
        description: mut.description,
        status: mut.targetStatus as PaperclipIssueStatus,
        priority: mut.priority,
        projectId: mut.paperclipProjectId,
      });
      nextLedger = upsertLedgerEntry(nextLedger, buildLedgerEntryFromMutation(mut, created.id, now), now);
      appliedCount += 1;
    } else if (mut.action === "update" && mut.paperclipIssueId && mut.paperclipCompanyId) {
      const updated = await client.updateIssue(mut.paperclipIssueId, {
        title: mut.title,
        description: mut.description,
        status: mut.targetStatus as PaperclipIssueStatus,
        priority: mut.priority,
      });
      nextLedger = upsertLedgerEntry(nextLedger, buildLedgerEntryFromMutation(mut, updated.id, now), now);
      appliedCount += 1;
    }
  }

  saveLedgerAtomic(nextLedger, { ledgerPath: deps.ledgerPath, fmHome });
  return { ...plan, mode: "apply", appliedCount };
}
