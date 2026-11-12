import { computeIssueContentHash } from "./ledger.js";
import { evaluateCustodyFence, resolveProjectGovernance } from "./policy.js";
import type {
  CustodySnapshot,
  FencedCustodyItem,
  FirstMateTaskSnapshot,
  GitHubPrRollup,
  LinearIssueSnapshot,
  PaperclipIssue,
  PaperclipIssuePriority,
  PaperclipIssueStatus,
  PaperclipOrgInstanceEntry,
  PaperclipOrgsConfig,
  ReadyQueueItem,
  SyncLedger,
  SyncMutation,
  SyncPlan,
} from "./types.js";

export interface ReconcileFilters {
  readonly project?: string | null;
  readonly initiative?: string | null;
  readonly limit?: number | null;
}

export interface ReconcileInput {
  readonly orgsConfig: PaperclipOrgsConfig;
  readonly orgCompanyMap: Readonly<Record<string, PaperclipOrgInstanceEntry>>;
  readonly linearIssues: readonly LinearIssueSnapshot[];
  readonly paperclipIssuesByOrg: Readonly<Record<string, readonly PaperclipIssue[]>>;
  readonly githubPrs: readonly GitHubPrRollup[];
  readonly fmTasks: readonly FirstMateTaskSnapshot[];
  readonly custody: CustodySnapshot;
  readonly ledger: SyncLedger;
  readonly filters?: ReconcileFilters;
  readonly now?: string;
}

interface DerivedTarget {
  readonly paperclipStatus: PaperclipIssueStatus;
  readonly linearTargetState: "Done" | "In Review" | "In Progress" | null;
  readonly githubPrUrl: string | null;
  readonly ciState: string | null;
  readonly fmTaskId: string | null;
  readonly fencedBy: string | null;
  readonly mergedRepo: string | null;
  readonly eligibleForReadyQueue: boolean;
  readonly reason: string;
}

export function mapLinearPriorityToPaperclip(priority: number): PaperclipIssuePriority {
  if (priority === 1) return "critical";
  if (priority === 2) return "high";
  if (priority === 3) return "medium";
  return "low";
}

function rankPriority(priority: number): number {
  return priority >= 1 && priority <= 4 ? priority : 5;
}

function linearNeedsStateTransition(
  issue: LinearIssueSnapshot,
  target: "Done" | "In Review" | "In Progress" | null,
): boolean {
  if (!target) return false;
  const currentName = issue.stateName.trim().toLowerCase();
  if (target === "Done") return issue.stateType !== "completed" && currentName !== "done";
  if (target === "In Review") return currentName !== "in review";
  return issue.stateType !== "started" || currentName === "in review";
}

function buildPaperclipTitle(identifier: string, rawTitle: string): string {
  const cleaned = rawTitle.replace(/^\s*\[(?:CYB|OCD)-\d+\]\s*/i, "").trim();
  return `[${identifier}] ${cleaned}`;
}

function buildPaperclipDescription(issue: LinearIssueSnapshot, derived: DerivedTarget): string {
  const lines = [
    `Linear: ${issue.identifier} (${issue.url})`,
    `Project: ${issue.projectId} — ${issue.projectName}`,
  ];
  if (derived.fencedBy) lines.push(`Custody Fence: ${derived.fencedBy} (${derived.reason})`);
  if (derived.fmTaskId) lines.push(`FirstMate Task: ${derived.fmTaskId} (adi0)`);
  if (derived.githubPrUrl) {
    lines.push(`GitHub PR: ${derived.githubPrUrl} (CI: ${derived.ciState ?? "UNKNOWN"})`);
  }
  if (issue.description.trim()) lines.push("", issue.description.trim());
  return lines.join("\n");
}

function findMatchingPaperclipIssue(
  identifier: string,
  orgIssues: readonly PaperclipIssue[],
  ledgerIssueId?: string,
): PaperclipIssue | undefined {
  if (ledgerIssueId) {
    const byId = orgIssues.find((item) => item.id === ledgerIssueId);
    if (byId) return byId;
  }
  const upperPrefix = `[${identifier.toUpperCase()}]`;
  return orgIssues.find((item) => item.title.trim().toUpperCase().startsWith(upperPrefix));
}

function makeDerived(
  paperclipStatus: PaperclipIssueStatus,
  reason: string,
  overrides: Partial<Omit<DerivedTarget, "paperclipStatus" | "reason">> = {},
): DerivedTarget {
  return {
    paperclipStatus,
    linearTargetState: null,
    githubPrUrl: null,
    ciState: null,
    fmTaskId: null,
    fencedBy: null,
    mergedRepo: null,
    eligibleForReadyQueue: false,
    reason,
    ...overrides,
  };
}

function deriveIssueTarget(
  config: PaperclipOrgsConfig,
  issue: LinearIssueSnapshot,
  prsForIssue: readonly GitHubPrRollup[],
  fmForIssue: FirstMateTaskSnapshot | undefined,
  ledgerFmTaskId: string | undefined,
  custody: CustodySnapshot,
  isTracked: boolean,
): DerivedTarget | null {
  const openPr = prsForIssue.find((pr) => pr.state === "OPEN");
  if (openPr) {
    return makeDerived("in_review", `Open PR ${openPr.url} (CI: ${openPr.ciState})`, {
      linearTargetState: "In Review",
      githubPrUrl: openPr.url,
      ciState: openPr.ciState,
      fmTaskId: fmForIssue?.taskId ?? ledgerFmTaskId ?? null,
    });
  }

  if (issue.stateType === "canceled") {
    return isTracked
      ? makeDerived("cancelled", `Canceled in Linear (${issue.stateName})`, {
          fmTaskId: ledgerFmTaskId ?? null,
        })
      : null;
  }

  const mergedPr = prsForIssue.find((pr) => pr.state === "MERGED");
  if (mergedPr) {
    if (issue.stateType === "completed" && !isTracked) return null;
    return makeDerived("done", `Merged PR ${mergedPr.url}`, {
      linearTargetState: "Done",
      githubPrUrl: mergedPr.url,
      ciState: mergedPr.ciState,
      fmTaskId: fmForIssue?.taskId ?? ledgerFmTaskId ?? null,
      mergedRepo: mergedPr.repo,
    });
  }

  if (issue.stateType === "completed") {
    return isTracked
      ? makeDerived("done", `Completed in Linear (${issue.stateName})`, {
          fmTaskId: ledgerFmTaskId ?? null,
        })
      : null;
  }

  const fence = evaluateCustodyFence(config, {
    issueId: issue.identifier,
    branchName: issue.branchName,
    custody,
  });
  if (fence.fenced) {
    return makeDerived("blocked", fence.reason ?? "External custody fence", {
      fencedBy: fence.fencedBy ?? custody.reviewforgeHost,
    });
  }

  const activeFmId =
    fmForIssue && (fmForIssue.status === "in_flight" || fmForIssue.status === "held")
      ? fmForIssue.taskId
      : ledgerFmTaskId;
  if (activeFmId) {
    return {
      paperclipStatus: "in_progress",
      linearTargetState: "In Progress",
      githubPrUrl: null,
      ciState: null,
      fmTaskId: activeFmId,
      fencedBy: null,
      mergedRepo: null,
      eligibleForReadyQueue: false,
      reason: `Active FirstMate task ${activeFmId}`,
    };
  }

  if (issue.blockedBy.length > 0) {
    return {
      paperclipStatus: "blocked",
      linearTargetState: null,
      githubPrUrl: null,
      ciState: null,
      fmTaskId: null,
      fencedBy: null,
      mergedRepo: null,
      eligibleForReadyQueue: false,
      reason: `Blocked by ${issue.blockedBy.join(", ")}`,
    };
  }

  const paperclipStatus: PaperclipIssueStatus =
    issue.stateType === "started"
      ? "in_progress"
      : issue.stateType === "backlog"
        ? "backlog"
        : "todo";
  return {
    paperclipStatus,
    linearTargetState: null,
    githubPrUrl: null,
    ciState: null,
    fmTaskId: null,
    fencedBy: null,
    mergedRepo: null,
    eligibleForReadyQueue: true,
    reason: `Unblocked Linear ${issue.stateName}`,
  };
}

export function reconcileFourWay(input: ReconcileInput): SyncPlan {
  const now = input.now ?? new Date().toISOString();
  const prByIssue = new Map<string, GitHubPrRollup[]>();
  for (const pr of input.githubPrs) {
    for (const rawId of pr.linearIdentifiers) {
      const key = rawId.toUpperCase();
      prByIssue.set(key, [...(prByIssue.get(key) ?? []), pr]);
    }
  }

  const fmByIssue = new Map<string, FirstMateTaskSnapshot>();
  for (const task of input.fmTasks) {
    for (const rawId of task.linearIdentifiers) fmByIssue.set(rawId.toUpperCase(), task);
  }

  const mutations: SyncMutation[] = [];
  const readyCandidates: ReadyQueueItem[] = [];
  const fencedItems: FencedCustodyItem[] = [];
  const fleetRepos = new Set<string>();
  const filterInit = input.filters?.initiative?.trim().toUpperCase() ?? "";
  const filterProj = input.filters?.project?.trim() ?? "";
  const resolvedFilterProj = filterProj ? resolveProjectGovernance(input.orgsConfig, filterProj) : null;

  for (const issue of input.linearIssues) {
    const gov =
      resolveProjectGovernance(input.orgsConfig, issue.projectId) ??
      resolveProjectGovernance(input.orgsConfig, issue.projectUuid) ??
      resolveProjectGovernance(input.orgsConfig, issue.projectName);
    if (!gov) continue;
    if (filterInit && gov.org.initiativeId.toUpperCase() !== filterInit) continue;
    if (filterProj && resolvedFilterProj?.project.id !== gov.project.id) continue;

    const key = issue.identifier.toUpperCase();
    const ledgerEntry = input.ledger.entries[key];
    const existingPcp = findMatchingPaperclipIssue(
      key,
      input.paperclipIssuesByOrg[gov.org.slug] ?? [],
      ledgerEntry?.paperclipIssueId,
    );
    const derived = deriveIssueTarget(
      input.orgsConfig,
      issue,
      prByIssue.get(key) ?? [],
      fmByIssue.get(key),
      ledgerEntry?.fmTaskId,
      input.custody,
      Boolean(existingPcp || ledgerEntry),
    );
    if (!derived) continue;

    if (derived.mergedRepo) fleetRepos.add(derived.mergedRepo);
    else if (derived.paperclipStatus === "done" && gov.project.primaryRepo) {
      fleetRepos.add(gov.project.primaryRepo);
    }

    if (derived.fencedBy) {
      fencedItems.push({
        linearIdentifier: key,
        orgSlug: gov.org.slug,
        projectSlug: gov.project.slug,
        fencedBy: derived.fencedBy,
        reason: derived.reason,
      });
    }

    const pcpPriority = mapLinearPriorityToPaperclip(issue.priority);
    const pcpTitle = buildPaperclipTitle(key, issue.title);
    const contentHash = computeIssueContentHash({
      linearIdentifier: key,
      title: pcpTitle,
      targetStatus: derived.paperclipStatus,
      priority: pcpPriority,
      githubPrUrl: derived.githubPrUrl,
      ciState: derived.ciState,
      fmTaskId: derived.fmTaskId,
      fencedBy: derived.fencedBy,
    });

    if (linearNeedsStateTransition(issue, derived.linearTargetState)) {
      mutations.push({
        target: "linear",
        action: "update",
        linearIdentifier: key,
        linearIssueUuid: issue.id,
        orgSlug: gov.org.slug,
        targetStatus: derived.linearTargetState!,
        contentHash,
        reason: derived.reason,
      });
    }

    const orgInstance = input.orgCompanyMap[gov.org.slug];
    const alreadySynced =
      Boolean(existingPcp) &&
      existingPcp?.status === derived.paperclipStatus &&
      ledgerEntry?.contentHash === contentHash;

    if (!alreadySynced && orgInstance) {
      const pcpProjectId = orgInstance.projectsBySlug[gov.project.slug];
      const assigneeId =
        derived.paperclipStatus === "in_progress" || derived.paperclipStatus === "in_review"
          ? (orgInstance.firstmateAgentId ?? gov.org.firstmateAgentId)
          : undefined;
      mutations.push({
        target: "paperclip",
        action: existingPcp ? "update" : "create",
        linearIdentifier: key,
        linearIssueUuid: issue.id,
        orgSlug: gov.org.slug,
        paperclipCompanyId: orgInstance.companyId,
        ...(pcpProjectId ? { paperclipProjectId: pcpProjectId } : {}),
        ...(existingPcp ? { paperclipIssueId: existingPcp.id } : {}),
        ...(assigneeId ? { assigneeAgentId: assigneeId } : {}),
        title: pcpTitle,
        description: buildPaperclipDescription(issue, derived),
        targetStatus: derived.paperclipStatus,
        priority: pcpPriority,
        ...(derived.githubPrUrl ? { githubPrUrl: derived.githubPrUrl } : {}),
        ...(derived.ciState ? { ciState: derived.ciState } : {}),
        ...(derived.fmTaskId ? { fmTaskId: derived.fmTaskId } : {}),
        ...(derived.fencedBy ? { fencedBy: derived.fencedBy } : {}),
        contentHash,
        reason: derived.reason,
      });
    }

    if (derived.eligibleForReadyQueue) {
      readyCandidates.push({
        linearIdentifier: key,
        title: issue.title,
        priority: issue.priority,
        paperclipPriority: pcpPriority,
        orgSlug: gov.org.slug,
        initiativeId: gov.org.initiativeId,
        projectSlug: gov.project.slug,
        primaryRepo: gov.project.primaryRepo,
        linearUrl: issue.url,
        state: issue.stateName,
        stateType: issue.stateType,
      });
    }
  }

  const rankedReady = [...readyCandidates].sort(
    (a, b) =>
      rankPriority(a.priority) - rankPriority(b.priority) ||
      a.linearIdentifier.localeCompare(b.linearIdentifier),
  );
  const limit = input.filters?.limit;
  return {
    generatedAt: now,
    mutations,
    readyQueue: typeof limit === "number" && limit > 0 ? rankedReady.slice(0, limit) : rankedReady,
    fencedItems,
    fleetSyncRepos: Array.from(fleetRepos).sort(),
    openPrs: input.githubPrs.filter((pr) => pr.state === "OPEN"),
    mergedPrs: input.githubPrs.filter((pr) => pr.state === "MERGED"),
  };
}
