import { z } from "zod";

export const PAPERCLIP_ISSUE_STATUSES = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "done",
  "blocked",
  "cancelled",
] as const;

export const PAPERCLIP_ISSUE_PRIORITIES = [
  "critical",
  "high",
  "medium",
  "low",
] as const;

export const PAPERCLIP_COMPANY_STATUSES = [
  "active",
  "paused",
  "archived",
] as const;

export const PaperclipIssueStatusSchema = z.enum(PAPERCLIP_ISSUE_STATUSES);
export type PaperclipIssueStatus = z.infer<typeof PaperclipIssueStatusSchema>;

export const PaperclipIssuePrioritySchema = z.enum(PAPERCLIP_ISSUE_PRIORITIES);
export type PaperclipIssuePriority = z.infer<typeof PaperclipIssuePrioritySchema>;

export const PaperclipCompanyStatusSchema = z.enum(PAPERCLIP_COMPANY_STATUSES);
export type PaperclipCompanyStatus = z.infer<typeof PaperclipCompanyStatusSchema>;

export const PaperclipHealthSchema = z.object({
  status: z.enum(["ok", "starting", "unhealthy"]),
  deploymentMode: z.string().optional(),
  deploymentExposure: z.string().optional(),
  version: z.string().optional(),
  commit: z.string().optional(),
  bootstrapStatus: z.string().optional(),
});
export type PaperclipHealth = z.infer<typeof PaperclipHealthSchema>;

export const PaperclipCompanySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().nullish(),
  status: PaperclipCompanyStatusSchema.optional().default("active"),
  budgetMonthlyCents: z.number().int().nonnegative().optional().default(0),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});
export type PaperclipCompany = z.infer<typeof PaperclipCompanySchema>;

export const PaperclipProjectSchema = z.object({
  id: z.string().min(1),
  companyId: z.string().min(1),
  name: z.string().min(1),
  description: z.string().nullish(),
  status: z.string().optional(),
});
export type PaperclipProject = z.infer<typeof PaperclipProjectSchema>;

export const PaperclipIssueSchema = z.object({
  id: z.string().min(1),
  companyId: z.string().min(1),
  projectId: z.string().nullish(),
  title: z.string().min(1),
  description: z.string().nullish(),
  status: PaperclipIssueStatusSchema,
  priority: PaperclipIssuePrioritySchema.optional().default("medium"),
  assigneeAgentId: z.string().nullish(),
  updatedAt: z.string().optional(),
});
export type PaperclipIssue = z.infer<typeof PaperclipIssueSchema>;

export const PaperclipActivitySchema = z.object({
  id: z.string().optional(),
  actorType: z.string().optional(),
  actorId: z.string().nullish(),
  action: z.string().min(1),
  entityType: z.string().min(1),
  entityId: z.string().min(1),
  details: z.record(z.string(), z.unknown()).nullish(),
  createdAt: z.string().min(1),
});
export type PaperclipActivity = z.infer<typeof PaperclipActivitySchema>;

export const McpGovernanceSchema = z.object({
  githubMergePr: z.literal(false),
  secretsRawExport: z.literal(false),
});
export type McpGovernance = z.infer<typeof McpGovernanceSchema>;

export const OrgCustodyFenceSummarySchema = z.object({
  reviewforgeHost: z.string().min(1),
  linearTeamFence: z.string().min(1),
});

export const GlobalCustodyFencesSchema = z.object({
  reviewforgeHost: z.string().min(1),
  linearTeamFence: z.string().min(1),
  fencedIssues: z.array(z.string().min(1)).readonly(),
  adi0CompanionIssues: z.array(z.string().min(1)).readonly(),
  fencedBranchPrefixes: z.array(z.string().min(1)).readonly(),
});

export const ControlAgentSpecSchema = z.object({
  name: z.string().min(1),
  host: z.string().min(1),
  adapter: z.string().min(1),
  codingAllowed: z.literal(false),
});

export const PaperclipProjectSpecSchema = z.object({
  id: z.string().min(1),
  slug: z.string().min(1),
  name: z.string().min(1),
  linearUuid: z.string().min(1),
  linearTeam: z.enum(["CYB", "OCD"]),
  primaryRepo: z.string().nullable(),
  repos: z.array(z.string().min(1)).readonly(),
  custodyHost: z.string().optional(),
  allowedHarnesses: z.array(z.string().min(1)).readonly().optional(),
  blockedHarnesses: z.array(z.string().min(1)).readonly().optional(),
});
export type PaperclipProjectSpec = z.infer<typeof PaperclipProjectSpecSchema>;

export const OrgGovernanceSpecSchema = z.object({
  executionTarget: z.literal("adi0-firstmate"),
  vpsLocalCodeExec: z.literal(false),
  allowedHarnesses: z.array(z.string().min(1)).readonly(),
  blockedHarnesses: z.array(z.string().min(1)).readonly(),
  mcpGovernance: McpGovernanceSchema,
  custodyFences: OrgCustodyFenceSummarySchema,
});

export const PaperclipOrgSpecSchema = z.object({
  slug: z.string().min(1),
  code: z.string().min(1).optional(),
  companyId: z.string().min(1).optional(),
  issuePrefix: z.string().min(1).optional(),
  firstmateAgentId: z.string().min(1).optional(),
  name: z.string().min(1),
  portfolioDomain: z.string().min(1),
  initiativeId: z.enum(["I-3", "I-4", "I-5", "I-6", "I-7", "I-8"]),
  initiativeUuid: z.string().min(1),
  initiativeUrl: z.string().url(),
  budgetMonthlyCents: z.number().int().nonnegative(),
  controlAgents: z.array(ControlAgentSpecSchema).readonly(),
  governance: OrgGovernanceSpecSchema,
  projects: z.array(PaperclipProjectSpecSchema).readonly(),
});
export type PaperclipOrgSpec = z.infer<typeof PaperclipOrgSpecSchema>;

export const PaperclipOrgsConfigSchema = z.object({
  schemaVersion: z.literal("paperclip-orgs.v1"),
  updatedAt: z.string().min(1),
  controlPlane: z.object({
    primaryApiBase: z.string().url(),
    standbyApiBase: z.string().url(),
    boardEnvPath: z.string().min(1),
    instanceMapPath: z.string().min(1),
    linearTeam: z.object({
      key: z.literal("CYB"),
      name: z.string().min(1),
      uuid: z.string().min(1),
    }),
  }),
  globalGovernance: z.object({
    executionTarget: z.literal("adi0-firstmate"),
    allowedExecutionHosts: z.array(z.string().min(1)).readonly(),
    forbiddenExecutionHosts: z.array(z.string().min(1)).readonly(),
    vpsLocalCodeExec: z.literal(false),
    mcpGovernance: McpGovernanceSchema,
    custodyFences: GlobalCustodyFencesSchema,
  }),
  organizations: z.array(PaperclipOrgSpecSchema).length(6).readonly(),
});
export type PaperclipOrgsConfig = z.infer<typeof PaperclipOrgsConfigSchema>;

export const PaperclipOrgInstanceEntrySchema = z.object({
  companyId: z.string().min(1),
  code: z.string().optional(),
  firstmateAgentId: z.string().optional(),
  projectsBySlug: z.record(z.string(), z.string().min(1)),
});
export type PaperclipOrgInstanceEntry = z.infer<typeof PaperclipOrgInstanceEntrySchema>;

export const PaperclipInstanceMapSchema = z.object({
  schemaVersion: z.string().optional().default("paperclip-instance.v1"),
  updatedAt: z.string().optional(),
  apiBase: z.string().optional(),
  organizations: z.record(z.string(), PaperclipOrgInstanceEntrySchema),
});
export type PaperclipInstanceMap = z.infer<typeof PaperclipInstanceMapSchema>;

export const LinearIssueSnapshotSchema = z.object({
  id: z.string().min(1),
  identifier: z.string().regex(/^(CYB|OCD)-\d+$/),
  title: z.string().min(1),
  description: z.string().default(""),
  url: z.string().min(1),
  stateType: z.enum(["backlog", "unstarted", "started", "completed", "canceled"]),
  stateName: z.string().min(1),
  priority: z.number().int().min(0).max(4),
  projectId: z.string().min(1),
  projectUuid: z.string().min(1),
  projectName: z.string().min(1),
  teamKey: z.enum(["CYB", "OCD"]),
  blockedBy: z.array(z.string()).readonly().default([]),
  branchName: z.string().optional(),
});
export type LinearIssueSnapshot = z.infer<typeof LinearIssueSnapshotSchema>;

export const GitHubPrRollupSchema = z.object({
  repo: z.string().regex(/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/),
  number: z.number().int().positive(),
  title: z.string().min(1),
  url: z.string().url(),
  state: z.enum(["OPEN", "MERGED", "CLOSED"]),
  headRefName: z.string().min(1),
  ciState: z.enum(["SUCCESS", "PENDING", "FAILURE", "UNKNOWN"]),
  linearIdentifiers: z.array(z.string()).readonly(),
  mergedAt: z.string().optional(),
});
export type GitHubPrRollup = z.infer<typeof GitHubPrRollupSchema>;

export const CustodySnapshotSchema = z.object({
  reviewforgeHost: z.string().min(1),
  fencedIssues: z.array(z.string()).readonly(),
  adi0CompanionIssues: z.array(z.string()).readonly(),
  activeBranches: z.array(z.string()).readonly(),
});
export type CustodySnapshot = z.infer<typeof CustodySnapshotSchema>;

export const FirstMateTaskSnapshotSchema = z.object({
  taskId: z.string().min(1),
  title: z.string().min(1),
  repo: z.string().optional(),
  status: z.enum(["in_flight", "queued", "held"]),
  linearIdentifiers: z.array(z.string()).readonly(),
  worktree: z.string().optional(),
  harness: z.string().optional(),
});
export type FirstMateTaskSnapshot = z.infer<typeof FirstMateTaskSnapshotSchema>;

export const SyncLedgerEntrySchema = z.object({
  linearIdentifier: z.string().min(1),
  linearIssueUuid: z.string().optional(),
  orgSlug: z.string().min(1),
  paperclipCompanyId: z.string().min(1),
  paperclipProjectId: z.string().optional(),
  paperclipIssueId: z.string().min(1),
  fmTaskId: z.string().optional(),
  worktree: z.string().optional(),
  harness: z.string().optional(),
  githubPrUrl: z.string().optional(),
  ciState: z.string().optional(),
  lastPaperclipStatus: PaperclipIssueStatusSchema,
  contentHash: z.string().min(1),
  fencedBy: z.string().optional(),
  updatedAt: z.string().min(1),
});
export type SyncLedgerEntry = z.infer<typeof SyncLedgerEntrySchema>;

export const SyncLedgerSchema = z.object({
  schemaVersion: z.literal("paperclip-sync-ledger.v1"),
  updatedAt: z.string().min(1),
  activityCursor: z.string().optional(),
  entries: z.record(z.string(), SyncLedgerEntrySchema),
});
export type SyncLedger = z.infer<typeof SyncLedgerSchema>;

export interface ReadyQueueItem {
  readonly linearIdentifier: string;
  readonly title: string;
  readonly priority: number;
  readonly paperclipPriority: PaperclipIssuePriority;
  readonly orgSlug: string;
  readonly initiativeId?: string;
  readonly projectSlug: string;
  readonly primaryRepo: string | null;
  readonly linearUrl: string;
  readonly state?: string;
  readonly stateType?: LinearIssueSnapshot["stateType"];
}

export interface SyncMutation {
  readonly target: "paperclip" | "linear";
  readonly action: "create" | "update";
  readonly linearIdentifier: string;
  readonly linearIssueUuid: string;
  readonly orgSlug: string;
  readonly paperclipCompanyId?: string;
  readonly paperclipProjectId?: string;
  readonly paperclipIssueId?: string;
  readonly assigneeAgentId?: string;
  readonly title?: string;
  readonly description?: string;
  readonly targetStatus: string;
  readonly priority?: PaperclipIssuePriority;
  readonly githubPrUrl?: string;
  readonly ciState?: string;
  readonly fmTaskId?: string;
  readonly fencedBy?: string;
  readonly contentHash: string;
  readonly reason: string;
}

export interface FencedCustodyItem {
  readonly linearIdentifier: string;
  readonly orgSlug: string;
  readonly projectSlug: string;
  readonly fencedBy: string;
  readonly reason: string;
}

export interface SyncPlan {
  readonly generatedAt: string;
  readonly mutations: readonly SyncMutation[];
  readonly readyQueue: readonly ReadyQueueItem[];
  readonly fencedItems: readonly FencedCustodyItem[];
  readonly fleetSyncRepos: readonly string[];
  readonly openPrs?: readonly GitHubPrRollup[];
  readonly mergedPrs?: readonly GitHubPrRollup[];
}

export interface GuardDispatchDecision {
  readonly allowed: boolean;
  readonly code:
    | "ALLOWED"
    | "FORBIDDEN_EXECUTION_HOST"
    | "FORBIDDEN_HARNESS"
    | "CUSTODY_FENCED"
    | "FORBIDDEN_MCP_ACTION"
    | "UNKNOWN_PROJECT";
  readonly reason: string;
  readonly orgSlug: string | null;
  readonly projectId: string | null;
  readonly projectSlug: string | null;
  readonly executionTarget: string;
  readonly host: string;
  readonly harness: string;
  readonly mcpGovernance: McpGovernance;
  readonly fencedBy: string | null;
}
