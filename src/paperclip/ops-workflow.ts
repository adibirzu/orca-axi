import { homedir, hostname as osHostname } from "node:os";
import { join } from "node:path";

import { normalizeLocalHostName } from "../agents/collect.js";
import { loadBoardAuthConfig, PaperclipClient } from "./client.js";
import type { DailyOpsClientPort } from "./daily-ops.js";
import {
  computeIssueContentHash,
  loadLedger,
  saveLedgerAtomic,
  updateLedgerCursor,
  upsertLedgerEntry,
} from "./ledger.js";
import {
  extractCanonicalIssueId,
  guardDispatch,
  type GuardDispatchRequest,
  loadPaperclipOrgsConfig,
  resolvePortableHomePath,
  resolveProjectGovernance,
} from "./policy.js";
import {
  fetchGitHubPrsLive,
  loadCustodySnapshotLive,
  loadInstanceMap,
  updateLinearIssueStateLive,
} from "./sources.js";
import type {
  CustodySnapshot,
  FirstMateTaskSnapshot,
  GitHubPrRollup,
  GuardDispatchDecision,
  LinearIssueSnapshot,
  PaperclipActivity,
  PaperclipOrgsConfig,
  SyncLedgerEntry,
} from "./types.js";

export interface PaperclipCliDeps {
  readonly configPath?: string;
  readonly ledgerPath?: string;
  readonly instanceMapPath?: string;
  readonly boardEnvPath?: string;
  readonly fmHome?: string;
  readonly client?: PaperclipClient;
  readonly dailyOpsPort?: DailyOpsClientPort;
  readonly fetchLinearIssues?: (config: PaperclipOrgsConfig) => Promise<LinearIssueSnapshot[]>;
  readonly updateLinearIssueState?: (
    issueUuid: string,
    targetStateName: string,
    teamUuid: string,
  ) => Promise<void>;
  readonly fetchGitHubPrs?: (repos: readonly string[]) => Promise<GitHubPrRollup[]>;
  readonly loadFirstMateTasks?: (fmHome: string) => FirstMateTaskSnapshot[];
  readonly loadCustodySnapshot?: (config: PaperclipOrgsConfig) => Promise<CustodySnapshot>;
  readonly writeStdout?: (text: string) => void;
  readonly writeStderr?: (text: string) => void;
  readonly now?: () => string;
}

function defaultFmHome(): string {
  return join(homedir(), "dev", "firstmate");
}

function resolveDefaultHost(): string {
  const fromEnv = process.env.HL_STATION_HOSTNAME?.trim();
  return normalizeLocalHostName(fromEnv || osHostname());
}

export function resolveDepsClient(
  deps: PaperclipCliDeps,
  config: PaperclipOrgsConfig,
): PaperclipClient {
  if (deps.client) return deps.client;
  const auth = loadBoardAuthConfig({
    boardEnvPath: deps.boardEnvPath ?? resolvePortableHomePath(config.controlPlane.boardEnvPath),
  });
  return new PaperclipClient({
    primaryBase: auth.primaryBase,
    standbyBase: auth.standbyBase,
    bearerToken: auth.bearerToken,
    cookieHeader: auth.cookieHeader,
  });
}

export async function runGuardDispatchOp(
  deps: PaperclipCliDeps,
  req: Omit<GuardDispatchRequest, "custody">,
): Promise<GuardDispatchDecision> {
  const config = loadPaperclipOrgsConfig({ configPath: deps.configPath });
  const custody = await (deps.loadCustodySnapshot ?? loadCustodySnapshotLive)(config);
  const fmHome = deps.fmHome ?? process.env.FM_HOME ?? defaultFmHome();
  const ledger = req.ledger ?? loadLedger({ ledgerPath: deps.ledgerPath, fmHome });

  const issueKey = extractCanonicalIssueId(req.issueId);
  let openPrs = req.openPrs;
  let liveIssueStatus = req.liveIssueStatus;

  if (issueKey) {
    if (openPrs === undefined) {
      const resolved = resolveProjectGovernance(config, req.project);
      if (resolved && resolved.project.repos.length > 0 && (deps.fetchGitHubPrs || !deps.client)) {
        try {
          openPrs = await (deps.fetchGitHubPrs ?? fetchGitHubPrsLive)(resolved.project.repos);
        } catch {
          openPrs = undefined;
        }
      }
    }

    const ledgerEntry = ledger.entries[issueKey];
    if (liveIssueStatus === undefined && ledgerEntry?.paperclipIssueId) {
      try {
        const client = resolveDepsClient(deps, config);
        const liveIssue = await client.getIssue(ledgerEntry.paperclipIssueId);
        liveIssueStatus = liveIssue.status;
      } catch {
        liveIssueStatus = undefined;
      }
    }
  }

  return guardDispatch(config, { ...req, custody, ledger, openPrs, liveIssueStatus });
}

export async function runClaimOp(
  deps: PaperclipCliDeps,
  input: {
    readonly linearId: string;
    readonly fmTaskId: string;
    readonly worktree: string;
    readonly harness?: string;
    readonly host?: string;
    readonly surface?: string;
    readonly branch?: string;
    readonly force?: boolean;
  },
): Promise<{ readonly entry: SyncLedgerEntry }> {
  const now = deps.now?.() ?? new Date().toISOString();
  const config = loadPaperclipOrgsConfig({ configPath: deps.configPath });
  const fmHome = deps.fmHome ?? process.env.FM_HOME ?? defaultFmHome();
  const key = extractCanonicalIssueId(input.linearId);
  if (!key) throw new Error(`Invalid Linear issue identifier: ${input.linearId}`);

  const ledger = loadLedger({ ledgerPath: deps.ledgerPath, fmHome });
  const existing = ledger.entries[key];
  if (!existing) {
    throw new Error(
      `Issue ${key} not yet in Paperclip sync ledger; run 'paperclip-cyb sync --apply' first`,
    );
  }

  if (
    !input.force &&
    existing.fmTaskId &&
    existing.fmTaskId !== input.fmTaskId &&
    (existing.lastPaperclipStatus === "in_progress" || existing.lastPaperclipStatus === "in_review")
  ) {
    throw new Error(
      `ISSUE_ALREADY_CLAIMED: Issue ${key} is already ${existing.lastPaperclipStatus} by FirstMate task '${existing.fmTaskId}' on ${existing.host ?? "unknown"}`,
    );
  }

  const host = normalizeLocalHostName(input.host?.trim() || resolveDefaultHost());
  const surface = input.surface?.trim() || (process.platform === "darwin" ? "orca" : "herdr");
  const client = resolveDepsClient(deps, config);
  await client.updateIssue(existing.paperclipIssueId, { status: "in_progress" });
  await client.addIssueComment(
    existing.paperclipIssueId,
    `Claimed on ${host} (${surface}) by FirstMate task \`${input.fmTaskId}\` (worktree: \`${input.worktree}\`${input.branch ? `, branch: \`${input.branch}\`` : ""}${input.harness ? `, harness: \`${input.harness}\`` : ""})`,
  );

  // Best-effort Linear status transition to In Progress
  const org = config.organizations.find((o) => o.slug === existing.orgSlug);
  const project = org?.projects.find((p) => p.id === existing.paperclipProjectId);
  const linearTeam = project?.linearTeam ?? (key.startsWith("OCD-") ? "OCD" : "CYB");
  if (existing.linearIssueUuid && (deps.updateLinearIssueState || process.env.LINEAR_API_KEY?.trim())) {
    try {
      await (deps.updateLinearIssueState ?? updateLinearIssueStateLive)(
        existing.linearIssueUuid,
        "In Progress",
        linearTeam,
      );
    } catch {
      // Linear sync failure must not undo an already-recorded Paperclip claim
    }
  }

  const hash = computeIssueContentHash({
    linearIdentifier: key,
    title: `[${key}]`,
    targetStatus: "in_progress",
    priority: "high",
    githubPrUrl: existing.githubPrUrl ?? null,
    ciState: existing.ciState ?? null,
    fmTaskId: input.fmTaskId,
    fencedBy: null,
  });

  const nextEntry: SyncLedgerEntry = {
    ...existing,
    fmTaskId: input.fmTaskId,
    worktree: input.worktree,
    host,
    surface,
    ...(input.branch ? { branch: input.branch } : {}),
    ...(input.harness ? { harness: input.harness } : {}),
    lastPaperclipStatus: "in_progress",
    contentHash: hash,
    updatedAt: now,
  };
  saveLedgerAtomic(upsertLedgerEntry(ledger, nextEntry, now), {
    ledgerPath: deps.ledgerPath,
    fmHome,
  });
  return { entry: nextEntry };
}

export async function runReportPrOp(
  deps: PaperclipCliDeps,
  input: { readonly linearId: string; readonly prUrl: string; readonly ciState?: string },
): Promise<{ readonly entry: SyncLedgerEntry }> {
  const now = deps.now?.() ?? new Date().toISOString();
  const config = loadPaperclipOrgsConfig({ configPath: deps.configPath });
  const fmHome = deps.fmHome ?? process.env.FM_HOME ?? defaultFmHome();
  const key = extractCanonicalIssueId(input.linearId);
  if (!key) throw new Error(`Invalid Linear issue identifier: ${input.linearId}`);

  const ledger = loadLedger({ ledgerPath: deps.ledgerPath, fmHome });
  const existing = ledger.entries[key];
  if (!existing) throw new Error(`Issue ${key} not found in Paperclip sync ledger`);

  const ci = (input.ciState ?? "UNKNOWN").toUpperCase();
  const client = resolveDepsClient(deps, config);
  await client.updateIssue(existing.paperclipIssueId, { status: "in_review" });
  await client.addIssueComment(
    existing.paperclipIssueId,
    `Pull request ready for review: ${input.prUrl} (CI: ${ci}). Note: auto-merge is disabled by governance.`,
  );

  const hash = computeIssueContentHash({
    linearIdentifier: key,
    title: `[${key}]`,
    targetStatus: "in_review",
    priority: "high",
    githubPrUrl: input.prUrl,
    ciState: ci,
    fmTaskId: existing.fmTaskId ?? null,
    fencedBy: null,
  });

  const nextEntry: SyncLedgerEntry = {
    ...existing,
    githubPrUrl: input.prUrl,
    ciState: ci,
    lastPaperclipStatus: "in_review",
    contentHash: hash,
    updatedAt: now,
  };
  saveLedgerAtomic(upsertLedgerEntry(ledger, nextEntry, now), {
    ledgerPath: deps.ledgerPath,
    fmHome,
  });
  return { entry: nextEntry };
}

export async function runWatchEventsOp(
  deps: PaperclipCliDeps,
  options: { readonly once: boolean; readonly timeoutSec: number },
): Promise<{
  readonly wake: boolean;
  readonly cursor: string | null;
  readonly events: readonly PaperclipActivity[];
}> {
  const nowFn = deps.now ?? (() => new Date().toISOString());
  const config = loadPaperclipOrgsConfig({ configPath: deps.configPath });
  const fmHome = deps.fmHome ?? process.env.FM_HOME ?? defaultFmHome();
  const instanceMap = loadInstanceMap(
    deps.instanceMapPath ?? resolvePortableHomePath(config.controlPlane.instanceMapPath),
  );
  const ledger = loadLedger({ ledgerPath: deps.ledgerPath, fmHome });
  const client = resolveDepsClient(deps, config);

  const deadline = Date.now() + Math.max(1, options.timeoutSec) * 1000;
  const sinceCursor = ledger.activityCursor ?? "";

  for (;;) {
    const seenIds = new Set<string>();
    const fresh: PaperclipActivity[] = [];
    for (const orgEntry of Object.values(instanceMap.organizations)) {
      const items = await client.listActivity(orgEntry.companyId, { entityType: "issue" });
      for (const act of items) {
        if (sinceCursor && act.createdAt <= sinceCursor) continue;
        const dedupeKey = act.id ?? `${act.action}:${act.entityId}:${act.createdAt}`;
        if (seenIds.has(dedupeKey)) continue;
        seenIds.add(dedupeKey);
        fresh.push(act);
      }
    }

    if (fresh.length > 0) {
      const sorted = [...fresh].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      const latestCursor = sorted[sorted.length - 1]!.createdAt;
      saveLedgerAtomic(updateLedgerCursor(ledger, latestCursor, nowFn()), {
        ledgerPath: deps.ledgerPath,
        fmHome,
      });
      return { wake: true, cursor: latestCursor, events: sorted };
    }

    if (options.once || Date.now() + 2000 >= deadline) {
      return { wake: false, cursor: ledger.activityCursor ?? null, events: [] };
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}
