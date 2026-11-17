import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { runPaperclipCybCli } from "../src/paperclip/cli.js";
import { PaperclipClient } from "../src/paperclip/client.js";
import {
  createHttpDailyOpsPort,
  type DailyOpsClientPort,
  planAndApplyDailyOps,
  runDailyOpsOp,
} from "../src/paperclip/daily-ops.js";
import type { PaperclipCliDeps } from "../src/paperclip/ops.js";
import { loadPaperclipOrgsConfig, resolveProjectGovernance } from "../src/paperclip/policy.js";

const CONFIG_PATH = fileURLToPath(new URL("../config/paperclip-orgs.json", import.meta.url));

function createStatefulDailyOpsMock() {
  const adapters = new Map<string, boolean>([
    ["hermes_gateway", false],
    ["http", false],
    ["codex_local", false],
    ["claude_local", false],
    ["process", true],
  ]);

  const goalsByCompany = new Map<
    string,
    Array<{ id: string; title: string; level: string; status: string; parentId?: string | null; ownerAgentId?: string | null }>
  >();
  const skillsByCompany = new Map<string, Array<{ id: string; slug: string; name: string }>>();
  const routinesByCompany = new Map<
    string,
    Array<{
      id: string;
      title: string;
      status: string;
      triggers: Array<{ id: string; kind: string; cronExpression?: string; timezone?: string; enabled?: boolean }>;
    }>
  >();
  const projectsByCompany = new Map<
    string,
    Array<{ id: string; companyId: string; name: string; goalIds?: readonly string[]; leadAgentId?: string | null }>
  >();

  const sidebarOrderCalls: Array<readonly string[]> = [];
  const projectSidebarCalls: Array<{ companyId: string; orderedIds: readonly string[] }> = [];
  const inboxPolicyCalls: Array<{ companyId: string; allowedAgentIds: readonly string[] }> = [];

  const config = loadPaperclipOrgsConfig({ configPath: CONFIG_PATH });
  for (const org of config.organizations) {
    const cid = org.companyId!;
    goalsByCompany.set(cid, []);
    skillsByCompany.set(cid, []);
    routinesByCompany.set(cid, []);
    projectsByCompany.set(
      cid,
      org.projects.map((p, idx) => ({
        id: `00000000-0000-4000-8000-${cid.slice(0, 8)}${String(idx).padStart(4, "0")}`,
        companyId: cid,
        name: p.name,
      })),
    );
  }

  let seq = 1;
  const nextUuid = () => `11111111-2222-4333-8444-${String(seq++).padStart(12, "0")}`;

  const port: DailyOpsClientPort = {
    listAdapters: vi.fn(async () =>
      Array.from(adapters.entries()).map(([type, disabled]) => ({ type, disabled })),
    ),
    setAdapterDisabled: vi.fn(async (type: string, disabled: boolean) => {
      adapters.set(type, disabled);
      return { type, disabled };
    }),
    listCompanyAgents: vi.fn(async (companyId: string) => {
      const org = config.organizations.find((o) => o.companyId === companyId);
      return (org?.controlAgents ?? []).map((ca, i) => ({
        id: ca.agentId ?? `22222222-3333-4444-8555-${companyId.slice(0, 8)}${String(i).padStart(4, "0")}`,
        name: ca.name,
        role: ca.role ?? "pm",
        adapterType: ca.adapter,
        status: "idle",
        lifecycleState: "ready",
      }));
    }),
    listGoals: vi.fn(async (companyId: string) => [...(goalsByCompany.get(companyId) ?? [])]),
    createGoal: vi.fn(async (companyId: string, input) => {
      const created = {
        id: nextUuid(),
        title: input.title,
        level: input.level,
        status: input.status ?? "active",
        parentId: input.parentId ?? null,
        ownerAgentId: input.ownerAgentId ?? null,
      };
      goalsByCompany.set(companyId, [...(goalsByCompany.get(companyId) ?? []), created]);
      return created;
    }),
    listProjects: vi.fn(async (companyId: string) => [...(projectsByCompany.get(companyId) ?? [])]),
    linkProjectGovernance: vi.fn(async (projectId: string, patch) => {
      for (const [cid, list] of projectsByCompany.entries()) {
        const idx = list.findIndex((p) => p.id === projectId);
        if (idx >= 0) {
          const updated = {
            ...list[idx]!,
            goalIds: patch.goalIds,
            leadAgentId: patch.leadAgentId,
          };
          projectsByCompany.set(
            cid,
            list.map((item, i) => (i === idx ? updated : item)),
          );
          return updated;
        }
      }
      throw new Error(`Project not found: ${projectId}`);
    }),
    listCompanySkills: vi.fn(async (companyId: string) => [...(skillsByCompany.get(companyId) ?? [])]),
    createCompanySkill: vi.fn(async (companyId: string, input) => {
      const created = { id: nextUuid(), slug: input.slug, name: input.name };
      skillsByCompany.set(companyId, [...(skillsByCompany.get(companyId) ?? []), created]);
      return created;
    }),
    listRoutines: vi.fn(async (companyId: string) => [...(routinesByCompany.get(companyId) ?? [])]),
    getRoutineDetail: vi.fn(async (routineId: string) => {
      for (const list of routinesByCompany.values()) {
        const hit = list.find((r) => r.id === routineId);
        if (hit) return hit;
      }
      throw new Error(`Routine not found: ${routineId}`);
    }),
    createRoutine: vi.fn(async (companyId: string, input) => {
      const created = {
        id: nextUuid(),
        title: input.title,
        status: input.status ?? "active",
        triggers: [],
      };
      routinesByCompany.set(companyId, [...(routinesByCompany.get(companyId) ?? []), created]);
      return created;
    }),
    createRoutineScheduleTrigger: vi.fn(async (routineId: string, input) => {
      const trig = {
        id: nextUuid(),
        kind: "schedule",
        cronExpression: input.cronExpression,
        timezone: input.timezone,
        enabled: true,
      };
      for (const [cid, list] of routinesByCompany.entries()) {
        const idx = list.findIndex((r) => r.id === routineId);
        if (idx >= 0) {
          const updated = { ...list[idx]!, triggers: [...list[idx]!.triggers, trig] };
          routinesByCompany.set(
            cid,
            list.map((item, i) => (i === idx ? updated : item)),
          );
          return trig;
        }
      }
      throw new Error(`Routine not found for trigger: ${routineId}`);
    }),
    setCompanySidebarOrder: vi.fn(async (orderedIds: readonly string[]) => {
      sidebarOrderCalls.push([...orderedIds]);
    }),
    setProjectSidebarOrder: vi.fn(async (companyId: string, orderedIds: readonly string[]) => {
      projectSidebarCalls.push({ companyId, orderedIds: [...orderedIds] });
    }),
    setInboxAgentPolicy: vi.fn(async (companyId: string, allowedAgentIds: readonly string[]) => {
      inboxPolicyCalls.push({ companyId, allowedAgentIds: [...allowedAgentIds] });
    }),
  };

  return {
    config,
    port,
    adapters,
    sidebarOrderCalls,
    projectSidebarCalls,
    inboxPolicyCalls,
  };
}

describe("paperclip daily-ops control plane reconciler & Mozaic HR G7 config", () => {
  it("maps Mozaic HR (P-CYB-MOZAIC) in CYB03 ENT and declares complete dailyOps config", () => {
    const config = loadPaperclipOrgsConfig({ configPath: CONFIG_PATH });
    const allProjects = config.organizations.flatMap((o) => o.projects);
    expect(allProjects).toHaveLength(30);

    const mozaic = resolveProjectGovernance(config, "mozaic-hr");
    expect(mozaic).not.toBeNull();
    expect(mozaic?.org.slug).toBe("cyb-03-erp-finance");
    expect(mozaic?.project.id).toBe("P-CYB-MOZAIC");
    expect(mozaic?.project.primaryRepo).toBe("adibirzu/mosaichr");

    const byRepo = resolveProjectGovernance(config, "adibirzu/mosaichr");
    expect(byRepo?.project.id).toBe("P-CYB-MOZAIC");

    expect(config.dailyOps).toBeDefined();
    expect(config.dailyOps?.allowedAdapters).toEqual(["hermes_gateway", "http"]);
    expect(config.dailyOps?.timezone).toBe("Europe/Bucharest");
    expect(config.dailyOps?.routines).toHaveLength(7);

    const totalGoals = Object.values(config.dailyOps?.goalsByOrg ?? {}).reduce(
      (sum, list) => sum + list.length,
      0,
    );
    expect(totalGoals).toBe(11);
  });

  it("plans daily-ops in dry-run without mutating remote state, then applies idempotently", async () => {
    const { config, port, adapters, sidebarOrderCalls, projectSidebarCalls, inboxPolicyCalls } =
      createStatefulDailyOpsMock();

    const dryReport = await planAndApplyDailyOps(config, port, { apply: false });
    expect(dryReport.mode).toBe("dry-run");
    expect(dryReport.adaptersToDisable).toEqual(["claude_local", "codex_local"]);
    expect(dryReport.plannedGoalsToCreate).toBe(11);
    expect(dryReport.plannedProjectsToLink).toBe(30);
    expect(dryReport.plannedSkillsToCreate).toBe(18);
    expect(dryReport.plannedRoutinesToCreate).toBe(7);
    expect(port.setAdapterDisabled).not.toHaveBeenCalled();
    expect(sidebarOrderCalls).toHaveLength(0);

    const applyReport = await planAndApplyDailyOps(config, port, { apply: true });
    expect(applyReport.mode).toBe("apply");
    expect(adapters.get("codex_local")).toBe(true);
    expect(adapters.get("claude_local")).toBe(true);
    expect(adapters.get("hermes_gateway")).toBe(false);
    expect(adapters.get("http")).toBe(false);
    expect(sidebarOrderCalls).toHaveLength(1);
    expect(sidebarOrderCalls[0]).toHaveLength(6);
    expect(projectSidebarCalls).toHaveLength(6);
    expect(inboxPolicyCalls).toHaveLength(6);

    // Second apply pass is strictly idempotent (zero new creations or adapter toggles)
    const secondApply = await planAndApplyDailyOps(config, port, { apply: true });
    expect(secondApply.adaptersToDisable).toEqual([]);
    expect(secondApply.plannedGoalsToCreate).toBe(0);
    expect(secondApply.plannedProjectsToLink).toBe(0);
    expect(secondApply.plannedSkillsToCreate).toBe(0);
    expect(secondApply.plannedRoutinesToCreate).toBe(0);
    expect(secondApply.plannedTriggersToCreate).toBe(0);
  });

  it("wires paperclip-cyb daily-ops [--dry-run|--apply] [--json] through CLI", async () => {
    const { port } = createStatefulDailyOpsMock();
    const stdout: string[] = [];
    const deps: PaperclipCliDeps = {
      configPath: CONFIG_PATH,
      dailyOpsPort: port,
      writeStdout: (s: string) => stdout.push(s),
    };

    const dryExit = await runPaperclipCybCli(["daily-ops", "--dry-run", "--json"], deps);
    expect(dryExit).toBe(0);
    const dryJson = JSON.parse(stdout.join(""));
    expect(dryJson.success).toBe(true);
    expect(dryJson.data.mode).toBe("dry-run");
    expect(dryJson.data.plannedRoutinesToCreate).toBe(7);

    stdout.length = 0;
    const humanExit = await runPaperclipCybCli(["daily-ops", "--apply"], deps);
    expect(humanExit).toBe(0);
    expect(stdout.join("")).toContain("paperclip-cyb daily-ops [apply]:");

    const directRes = await runDailyOpsOp(deps, { apply: false });
    expect(directRes.plannedGoalsToCreate).toBe(0);
  });

  it("maps HTTP endpoints cleanly through createHttpDailyOpsPort", async () => {
    const calls: Array<{ url: string; method: string; body?: string }> = [];
    const fakeFetch: typeof fetch = vi.fn(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push({ url, method, body: typeof init?.body === "string" ? init.body : undefined });
      if (url.endsWith("/api/adapters") && method === "GET") {
        return new Response(JSON.stringify([{ type: "hermes_gateway", disabled: false }]));
      }
      if (url.includes("/api/adapters/") && method === "PATCH") {
        return new Response(JSON.stringify({ type: "codex_local", disabled: true }));
      }
      if (url.endsWith("/agents")) {
        return new Response(JSON.stringify([{ id: "a-1", name: "Dot-Ops", status: "idle", lifecycleState: "ready" }]));
      }
      if (url.endsWith("/goals") && method === "GET") {
        return new Response(JSON.stringify([]));
      }
      if (url.endsWith("/goals") && method === "POST") {
        return new Response(JSON.stringify({ id: "g-1", title: "G", level: "company", status: "active" }));
      }
      if (url.endsWith("/projects") && method === "GET") {
        return new Response(JSON.stringify([{ id: "p-1", companyId: "c-1", name: "FirstMate" }]));
      }
      if (url.includes("/api/projects/") && method === "PATCH") {
        return new Response(JSON.stringify({ id: "p-1", companyId: "c-1", name: "FirstMate", goalIds: ["g-1"], leadAgentId: "a-1" }));
      }
      if (url.endsWith("/skills") && method === "GET") {
        return new Response(JSON.stringify([]));
      }
      if (url.endsWith("/skills") && method === "POST") {
        return new Response(JSON.stringify({ id: "s-1", slug: "isa-finisher-gate", name: "ISA" }));
      }
      if (url.endsWith("/routines") && method === "GET") {
        return new Response(JSON.stringify([]));
      }
      if (url.endsWith("/routines") && method === "POST") {
        return new Response(JSON.stringify({ id: "r-1", title: "Morning", status: "active" }));
      }
      if (url.endsWith("/api/routines/r-1") && method === "GET") {
        return new Response(JSON.stringify({ id: "r-1", title: "Morning", status: "active", triggers: [] }));
      }
      if (url.endsWith("/triggers") && method === "POST") {
        return new Response(JSON.stringify({ trigger: { id: "t-1", kind: "schedule", cronExpression: "50 6 * * *", timezone: "Europe/Bucharest", enabled: true } }));
      }
      return new Response(JSON.stringify({ ok: true }));
    });

    const client = new PaperclipClient({
      primaryBase: "https://paperclip.test",
      standbyBase: "https://paperclip.test",
      bearerToken: "tok",
      fetchImpl: fakeFetch,
    });
    const port = createHttpDailyOpsPort(client);

    expect(await port.listAdapters()).toEqual([{ type: "hermes_gateway", disabled: false }]);
    expect(await port.setAdapterDisabled("codex_local", true)).toEqual({ type: "codex_local", disabled: true });
    expect((await port.listCompanyAgents("c-1"))[0]?.name).toBe("Dot-Ops");
    expect(await port.listGoals("c-1")).toEqual([]);
    expect((await port.createGoal("c-1", { title: "G", description: "D", level: "company", status: "active" })).id).toBe("g-1");
    expect((await port.listProjects("c-1"))[0]?.id).toBe("p-1");
    expect((await port.linkProjectGovernance("p-1", { goalIds: ["g-1"], leadAgentId: "a-1" })).leadAgentId).toBe("a-1");
    expect(await port.listCompanySkills("c-1")).toEqual([]);
    expect((await port.createCompanySkill("c-1", { slug: "isa-finisher-gate", name: "ISA", tagline: "t", description: "d", categories: ["gov"], markdown: "# M" })).id).toBe("s-1");
    expect(await port.listRoutines("c-1")).toEqual([]);
    expect((await port.createRoutine("c-1", { title: "Morning", description: "d", assigneeAgentId: "a-1", projectId: "p-1", goalId: "g-1", priority: "high", status: "active", concurrencyPolicy: "coalesce_if_active", catchUpPolicy: "skip_missed" })).id).toBe("r-1");
    expect((await port.getRoutineDetail("r-1")).id).toBe("r-1");
    expect((await port.createRoutineScheduleTrigger("r-1", { label: "Daily", cronExpression: "50 6 * * *", timezone: "Europe/Bucharest" })).id).toBe("t-1");
    await port.setCompanySidebarOrder(["c-1"]);
    await port.setProjectSidebarOrder("c-1", ["p-1"]);
    await port.setInboxAgentPolicy("c-1", ["a-1"]);

    expect(calls.some((c) => c.url.endsWith("/users/me/inbox-agent-policy") && c.method === "PUT")).toBe(true);
  });

  it("rejects missing dailyOps configuration cleanly", async () => {
    const config = loadPaperclipOrgsConfig({ configPath: CONFIG_PATH });
    const stripped = { ...config, dailyOps: undefined };
    const { port } = createStatefulDailyOpsMock();
    await expect(planAndApplyDailyOps(stripped, port, { apply: false })).rejects.toThrow(
      /Missing dailyOps/,
    );
  });
});
