import { z } from "zod";

import type { PaperclipClient } from "./client.js";
import type {
  DailyOpsGoalSpec,
  DailyOpsRoutineSpec,
  DailyOpsSkillSpec,
  DailyOpsSpec,
} from "./daily-ops-types.js";
import type { PaperclipCliDeps } from "./ops-workflow.js";
import { resolveDepsClient } from "./ops-workflow.js";
import { loadPaperclipOrgsConfig } from "./policy.js";
import type { PaperclipOrgsConfig, PaperclipOrgSpec } from "./types.js";

export interface AdapterRecord {
  readonly type: string;
  readonly disabled: boolean;
}

export interface AgentSummaryRecord {
  readonly id: string;
  readonly name: string;
  readonly role?: string;
  readonly adapterType?: string;
  readonly status?: string;
  readonly lifecycleState?: string;
}

export interface GoalRecord {
  readonly id: string;
  readonly title: string;
  readonly level: string;
  readonly status: string;
  readonly parentId?: string | null;
  readonly ownerAgentId?: string | null;
}

export interface ProjectSummaryRecord {
  readonly id: string;
  readonly companyId: string;
  readonly name: string;
  readonly goalIds?: readonly string[];
  readonly leadAgentId?: string | null;
}

export interface SkillSummaryRecord {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
}

export interface RoutineTriggerRecord {
  readonly id: string;
  readonly kind: string;
  readonly cronExpression?: string | null;
  readonly timezone?: string | null;
  readonly enabled?: boolean;
}

export interface RoutineSummaryRecord {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly triggers?: readonly RoutineTriggerRecord[];
}

export interface DailyOpsClientPort {
  listAdapters(): Promise<readonly AdapterRecord[]>;
  setAdapterDisabled(type: string, disabled: boolean): Promise<AdapterRecord>;
  listCompanyAgents(companyId: string): Promise<readonly AgentSummaryRecord[]>;
  listGoals(companyId: string): Promise<readonly GoalRecord[]>;
  createGoal(
    companyId: string,
    input: {
      readonly title: string;
      readonly description: string;
      readonly level: string;
      readonly status: "active";
      readonly parentId?: string | null;
      readonly ownerAgentId?: string | null;
    },
  ): Promise<GoalRecord>;
  listProjects(companyId: string): Promise<readonly ProjectSummaryRecord[]>;
  linkProjectGovernance(
    projectId: string,
    patch: { readonly goalIds: readonly string[]; readonly leadAgentId: string | null },
  ): Promise<ProjectSummaryRecord>;
  listCompanySkills(companyId: string): Promise<readonly SkillSummaryRecord[]>;
  createCompanySkill(
    companyId: string,
    input: DailyOpsSkillSpec,
  ): Promise<SkillSummaryRecord>;
  listRoutines(companyId: string): Promise<readonly RoutineSummaryRecord[]>;
  getRoutineDetail(routineId: string): Promise<RoutineSummaryRecord>;
  createRoutine(
    companyId: string,
    input: {
      readonly title: string;
      readonly description: string;
      readonly assigneeAgentId: string | null;
      readonly projectId: string | null;
      readonly goalId: string | null;
      readonly priority: string;
      readonly status: "active";
      readonly concurrencyPolicy: "coalesce_if_active";
      readonly catchUpPolicy: "skip_missed";
    },
  ): Promise<RoutineSummaryRecord>;
  createRoutineScheduleTrigger(
    routineId: string,
    input: {
      readonly label: string;
      readonly cronExpression: string;
      readonly timezone: string;
    },
  ): Promise<RoutineTriggerRecord>;
  setCompanySidebarOrder(orderedIds: readonly string[]): Promise<void>;
  setProjectSidebarOrder(companyId: string, orderedIds: readonly string[]): Promise<void>;
  setInboxAgentPolicy(companyId: string, allowedAgentIds: readonly string[]): Promise<void>;
}

export interface DailyOpsReport {
  readonly mode: "dry-run" | "apply";
  readonly adaptersToDisable: readonly string[];
  readonly plannedGoalsToCreate: number;
  readonly plannedProjectsToLink: number;
  readonly plannedSkillsToCreate: number;
  readonly plannedRoutinesToCreate: number;
  readonly plannedTriggersToCreate: number;
  readonly organizationsConfigured: number;
}

const AdapterSchema = z.object({
  type: z.string().min(1),
  disabled: z.boolean().optional().default(false),
});
const AgentSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  role: z.string().optional(),
  adapterType: z.string().optional(),
  status: z.string().optional(),
  lifecycleState: z.string().nullish().transform((v) => v ?? undefined),
});
const GoalSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  level: z.string().default("company"),
  status: z.string().default("active"),
  parentId: z.string().nullish(),
  ownerAgentId: z.string().nullish(),
});
const ProjectWithLinksSchema = z.object({
  id: z.string().min(1),
  companyId: z.string().min(1),
  name: z.string().min(1),
  goalIds: z.array(z.string()).optional(),
  leadAgentId: z.string().nullish(),
});
const SkillSchema = z.object({
  id: z.string().min(1),
  slug: z.string().min(1),
  name: z.string().min(1),
});
const TriggerSchema = z.object({
  id: z.string().min(1),
  kind: z.string().min(1),
  cronExpression: z.string().nullish(),
  timezone: z.string().nullish(),
  enabled: z.boolean().optional(),
});
const RoutineSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  status: z.string().default("active"),
  triggers: z.array(TriggerSchema).optional(),
});

export function createHttpDailyOpsPort(client: PaperclipClient): DailyOpsClientPort {
  const enc = encodeURIComponent;
  return {
    listAdapters: () => client.requestJson("/api/adapters", z.array(AdapterSchema)),
    setAdapterDisabled: (type, disabled) =>
      client.requestJson(`/api/adapters/${enc(type)}`, AdapterSchema, {
        method: "PATCH",
        body: { disabled },
      }),
    listCompanyAgents: (cid) =>
      client.requestJson(`/api/companies/${enc(cid)}/agents`, z.array(AgentSchema)),
    listGoals: (cid) =>
      client.requestJson(`/api/companies/${enc(cid)}/goals`, z.array(GoalSchema)),
    createGoal: (cid, input) =>
      client.requestJson(`/api/companies/${enc(cid)}/goals`, GoalSchema, {
        method: "POST",
        body: input,
      }),
    listProjects: (cid) =>
      client.requestJson(`/api/companies/${enc(cid)}/projects`, z.array(ProjectWithLinksSchema)),
    linkProjectGovernance: (pid, patch) =>
      client.requestJson(`/api/projects/${enc(pid)}`, ProjectWithLinksSchema, {
        method: "PATCH",
        body: patch,
      }),
    listCompanySkills: (cid) =>
      client.requestJson(`/api/companies/${enc(cid)}/skills`, z.array(SkillSchema)),
    createCompanySkill: (cid, input) =>
      client.requestJson(`/api/companies/${enc(cid)}/skills`, SkillSchema, {
        method: "POST",
        body: { ...input, sharingScope: "company" },
      }),
    listRoutines: (cid) =>
      client.requestJson(`/api/companies/${enc(cid)}/routines`, z.array(RoutineSchema)),
    getRoutineDetail: (rid) => client.requestJson(`/api/routines/${enc(rid)}`, RoutineSchema),
    createRoutine: (cid, input) =>
      client.requestJson(`/api/companies/${enc(cid)}/routines`, RoutineSchema, {
        method: "POST",
        body: input,
      }),
    createRoutineScheduleTrigger: async (rid, input) => {
      const res = await client.requestJson(
        `/api/routines/${enc(rid)}/triggers`,
        z.object({ trigger: TriggerSchema.optional(), id: z.string().optional() }),
        { method: "POST", body: { kind: "schedule", enabled: true, ...input } },
      );
      return res.trigger ?? { id: res.id ?? rid, kind: "schedule", ...input, enabled: true };
    },
    setCompanySidebarOrder: async (orderedIds) => {
      await client.requestJson("/api/sidebar-preferences/me", z.unknown(), {
        method: "PUT",
        body: { orderedIds },
      });
    },
    setProjectSidebarOrder: async (cid, orderedIds) => {
      await client.requestJson(`/api/companies/${enc(cid)}/sidebar-preferences/me`, z.unknown(), {
        method: "PUT",
        body: { orderedIds },
      });
    },
    setInboxAgentPolicy: async (cid, allowedAgentIds) => {
      await client.requestJson(
        `/api/companies/${enc(cid)}/users/me/inbox-agent-policy`,
        z.unknown(),
        { method: "PUT", body: { mode: "allowlist", allowedAgentIds } },
      );
    },
  };
}

async function reconcileAdapterGuardrail(
  spec: DailyOpsSpec,
  port: DailyOpsClientPort,
  apply: boolean,
): Promise<readonly string[]> {
  const allowed = new Set(spec.allowedAdapters);
  const current = await port.listAdapters();
  const toDisable = current
    .filter((a) => !allowed.has(a.type) && !a.disabled)
    .map((a) => a.type)
    .sort((a, b) => a.localeCompare(b));
  if (apply) {
    for (const adapterType of toDisable) {
      await port.setAdapterDisabled(adapterType, true);
    }
  }
  return toDisable;
}

async function reconcileOrgGoals(
  companyId: string,
  specs: readonly DailyOpsGoalSpec[],
  agentsByName: ReadonlyMap<string, string>,
  port: DailyOpsClientPort,
  apply: boolean,
): Promise<{ readonly createdOrPlanned: number; readonly goalIdsByKey: ReadonlyMap<string, string> }> {
  const existing = await port.listGoals(companyId);
  const byTitle = new Map(existing.map((g) => [g.title, g.id]));
  const idsByKey = new Map<string, string>();
  let count = 0;

  for (const g of specs) {
    const foundId = byTitle.get(g.title);
    if (foundId) {
      idsByKey.set(g.key, foundId);
      continue;
    }
    count += 1;
    if (apply) {
      const created = await port.createGoal(companyId, {
        title: g.title,
        description: g.description,
        level: g.level,
        status: "active",
        parentId: g.parentKey ? (idsByKey.get(g.parentKey) ?? null) : null,
        ownerAgentId: agentsByName.get(g.ownerAgentName) ?? null,
      });
      idsByKey.set(g.key, created.id);
    }
  }
  return { createdOrPlanned: count, goalIdsByKey: idsByKey };
}

function sameStringSet(a: readonly string[] | undefined, b: readonly string[]): boolean {
  if (!a || a.length !== b.length) return false;
  const setA = new Set(a);
  return b.every((item) => setA.has(item));
}

async function reconcileOrgProjectsAndCockpit(
  org: PaperclipOrgSpec,
  spec: DailyOpsSpec,
  agentsByName: ReadonlyMap<string, string>,
  goalIds: readonly string[],
  port: DailyOpsClientPort,
  apply: boolean,
): Promise<{ readonly linkedCount: number; readonly projectsByName: ReadonlyMap<string, string> }> {
  const cid = org.companyId!;
  const orgCode = org.issuePrefix!;
  const projects = await port.listProjects(cid);
  const defaultCoordName = org.controlAgents[0]?.name ?? "";
  const defaultLead = agentsByName.get(defaultCoordName) ?? null;
  let linkedCount = 0;

  for (const proj of projects) {
    const overrideName = spec.projectLeadAgentOverrides?.[proj.name];
    const desiredLead = overrideName ? (agentsByName.get(overrideName) ?? defaultLead) : defaultLead;
    const needsLink = !sameStringSet(proj.goalIds, goalIds) || proj.leadAgentId !== desiredLead;
    if (needsLink) {
      linkedCount += 1;
      if (apply && goalIds.length > 0) {
        await port.linkProjectGovernance(proj.id, { goalIds, leadAgentId: desiredLead });
      }
    }
  }

  const byName = new Map(projects.map((p) => [p.name, p.id]));
  if (apply) {
    const preferred = spec.preferredProjectOrder[orgCode] ?? [];
    const ordered = [
      ...preferred.map((n) => byName.get(n)).filter((v): v is string => Boolean(v)),
      ...projects.map((p) => p.id).filter((id) => !preferred.some((n) => byName.get(n) === id)),
    ];
    await port.setProjectSidebarOrder(cid, ordered);
    if (defaultLead) await port.setInboxAgentPolicy(cid, [defaultLead]);
  }
  return { linkedCount, projectsByName: byName };
}

async function reconcileOrgSkills(
  companyId: string,
  desired: readonly DailyOpsSkillSpec[],
  port: DailyOpsClientPort,
  apply: boolean,
): Promise<number> {
  const existing = await port.listCompanySkills(companyId);
  const slugs = new Set(existing.map((s) => s.slug));
  let count = 0;
  for (const skill of desired) {
    if (slugs.has(skill.slug)) continue;
    count += 1;
    if (apply) await port.createCompanySkill(companyId, skill);
  }
  return count;
}

async function reconcileRoutines(
  config: PaperclipOrgsConfig,
  spec: DailyOpsSpec,
  orgCtx: ReadonlyMap<
    string,
    {
      readonly companyId: string;
      readonly agentsByName: ReadonlyMap<string, string>;
      readonly goalsByKey: ReadonlyMap<string, string>;
      readonly projectsByName: ReadonlyMap<string, string>;
    }
  >,
  port: DailyOpsClientPort,
  apply: boolean,
): Promise<{ readonly routinesPlanned: number; readonly triggersPlanned: number }> {
  const existingByOrg = new Map<string, readonly RoutineSummaryRecord[]>();
  for (const org of config.organizations) {
    if (org.issuePrefix && org.companyId) {
      existingByOrg.set(org.issuePrefix, await port.listRoutines(org.companyId));
    }
  }

  let routinesPlanned = 0;
  let triggersPlanned = 0;
  for (const r of spec.routines) {
    const ctx = orgCtx.get(r.orgCode);
    if (!ctx) continue;
    const found = (existingByOrg.get(r.orgCode) ?? []).find((item) => item.title === r.title);

    if (!found) {
      routinesPlanned += 1;
      triggersPlanned += 1;
      if (apply) {
        const created = await port.createRoutine(ctx.companyId, {
          title: r.title,
          description: r.description,
          assigneeAgentId: ctx.agentsByName.get(r.assigneeAgentName) ?? null,
          projectId: r.projectName ? (ctx.projectsByName.get(r.projectName) ?? null) : null,
          goalId: ctx.goalsByKey.get(r.goalKey) ?? null,
          priority: r.priority,
          status: "active",
          concurrencyPolicy: "coalesce_if_active",
          catchUpPolicy: "skip_missed",
        });
        await port.createRoutineScheduleTrigger(created.id, {
          label: r.label,
          cronExpression: r.cron,
          timezone: spec.timezone,
        });
      }
      continue;
    }

    const detail = await port.getRoutineDetail(found.id);
    const hasSchedule = (detail.triggers ?? []).some((t) => t.kind === "schedule");
    if (!hasSchedule) {
      triggersPlanned += 1;
      if (apply) {
        await port.createRoutineScheduleTrigger(found.id, {
          label: r.label,
          cronExpression: r.cron,
          timezone: spec.timezone,
        });
      }
    }
  }
  return { routinesPlanned, triggersPlanned };
}

export async function planAndApplyDailyOps(
  config: PaperclipOrgsConfig,
  port: DailyOpsClientPort,
  options: { readonly apply: boolean },
): Promise<DailyOpsReport> {
  const spec = config.dailyOps;
  if (!spec) {
    throw new Error("Missing dailyOps configuration section in paperclip-orgs.json");
  }

  const adaptersToDisable = await reconcileAdapterGuardrail(spec, port, options.apply);
  let plannedGoalsToCreate = 0;
  let plannedProjectsToLink = 0;
  let plannedSkillsToCreate = 0;

  const orgCtx = new Map<
    string,
    {
      readonly companyId: string;
      readonly agentsByName: ReadonlyMap<string, string>;
      readonly goalsByKey: ReadonlyMap<string, string>;
      readonly projectsByName: ReadonlyMap<string, string>;
    }
  >();

  for (const org of config.organizations) {
    const cid = org.companyId;
    const code = org.issuePrefix;
    if (!cid || !code) continue;

    const agents = await port.listCompanyAgents(cid);
    const agentsByName = new Map(agents.map((a) => [a.name, a.id]));
    const goalsRes = await reconcileOrgGoals(
      cid,
      spec.goalsByOrg[code] ?? [],
      agentsByName,
      port,
      options.apply,
    );
    plannedGoalsToCreate += goalsRes.createdOrPlanned;

    const goalIds = Array.from(goalsRes.goalIdsByKey.values());
    const projRes = await reconcileOrgProjectsAndCockpit(
      org,
      spec,
      agentsByName,
      goalIds,
      port,
      options.apply,
    );
    plannedProjectsToLink += projRes.linkedCount;

    const desiredSkills: readonly DailyOpsSkillSpec[] = [
      ...spec.commonSkills,
      ...(spec.skillsByOrg[code] ?? []),
    ];
    plannedSkillsToCreate += await reconcileOrgSkills(cid, desiredSkills, port, options.apply);

    orgCtx.set(code, {
      companyId: cid,
      agentsByName,
      goalsByKey: goalsRes.goalIdsByKey,
      projectsByName: projRes.projectsByName,
    });
  }

  if (options.apply) {
    const byPrefix = new Map(
      config.organizations
        .filter((o): o is PaperclipOrgSpec & { issuePrefix: string; companyId: string } =>
          Boolean(o.issuePrefix && o.companyId),
        )
        .map((o) => [o.issuePrefix, o.companyId]),
    );
    const orderedCompanyIds = spec.companySidebarOrder
      .map((code) => byPrefix.get(code))
      .filter((v): v is string => Boolean(v));
    await port.setCompanySidebarOrder(orderedCompanyIds);
  }

  const routineCounts = await reconcileRoutines(config, spec, orgCtx, port, options.apply);
  return {
    mode: options.apply ? "apply" : "dry-run",
    adaptersToDisable,
    plannedGoalsToCreate,
    plannedProjectsToLink,
    plannedSkillsToCreate,
    plannedRoutinesToCreate: routineCounts.routinesPlanned,
    plannedTriggersToCreate: routineCounts.triggersPlanned,
    organizationsConfigured: orgCtx.size,
  };
}

export async function runDailyOpsOp(
  deps: PaperclipCliDeps,
  options: { readonly apply: boolean },
): Promise<DailyOpsReport> {
  const config = loadPaperclipOrgsConfig({ configPath: deps.configPath });
  const port = deps.dailyOpsPort ?? createHttpDailyOpsPort(resolveDepsClient(deps, config));
  return planAndApplyDailyOps(config, port, options);
}

export type { DailyOpsRoutineSpec };
