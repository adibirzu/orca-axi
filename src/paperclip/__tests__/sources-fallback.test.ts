import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createEmptyLedger } from "../ledger.js";
import { loadPaperclipOrgsConfig } from "../policy.js";
import { reconcileFourWay } from "../reconciler.js";
import {
  fetchGitHubPrsLive,
  fetchLinearIssuesLive,
  updateLinearIssueStateLive,
} from "../sources.js";

const CONFIG_PATH = fileURLToPath(new URL("../../../config/paperclip-orgs.json", import.meta.url));

describe("3-tier headless Linear resolution, bounded PR concurrency, and clutter filter", () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "paperclip-fallback-test-"));
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it("Tier 1: paginates CYB issues across multiple pages AND fetches cross-team P-OCD-70 when LINEAR_API_KEY is set", async () => {
    const config = loadPaperclipOrgsConfig({ configPath: CONFIG_PATH });
    const mockFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        query: string;
        variables: Record<string, unknown>;
      };
      if (body.query.includes("TeamIssuesPage")) {
        if (!body.variables.after) {
          return new Response(
            JSON.stringify({
              data: {
                issues: {
                  pageInfo: { hasNextPage: true, endCursor: "cur-1" },
                  nodes: [
                    {
                      id: "uuid-cyb-1",
                      identifier: "CYB-1",
                      title: "Page 1 issue",
                      description: "",
                      url: "https://linear.app/cyber-sec/issue/CYB-1",
                      priority: 2,
                      state: { name: "Todo", type: "unstarted" },
                      project: { id: "8ff1e728-4d61-42e4-9471-33bedb5d5cc9", name: "Orca & AXI Plugins" },
                      inverseRelations: { nodes: [] },
                    },
                  ],
                },
              },
            }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({
            data: {
              issues: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  {
                    id: "uuid-cyb-251",
                    identifier: "CYB-251",
                    title: "Page 2 issue",
                    description: "",
                    url: "https://linear.app/cyber-sec/issue/CYB-251",
                    priority: 1,
                    state: { name: "In Progress", type: "started" },
                    project: { id: "0660fe2f-23d4-43bf-9e2e-700ba8a57b99", name: "FirstMate" },
                    inverseRelations: { nodes: [] },
                  },
                ],
              },
            },
          }),
          { status: 200 },
        );
      }

      if (body.query.includes("ProjectIssuesPage")) {
        return new Response(
          JSON.stringify({
            data: {
              project: {
                issues: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    {
                      id: "uuid-ocd-498",
                      identifier: "OCD-498",
                      title: "RF03 Core ReviewForge",
                      description: "",
                      url: "https://linear.app/cyber-sec/issue/OCD-498",
                      priority: 1,
                      state: { name: "In Progress", type: "started" },
                      project: { id: "c1ee7da9-3729-4f70-9225-922039ce4897", name: "ReviewForge" },
                      inverseRelations: { nodes: [] },
                    },
                  ],
                },
              },
            },
          }),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 404 });
    });

    const issues = await fetchLinearIssuesLive(config, {
      apiKey: "lin_stub",
      fetchImpl: mockFetch as unknown as typeof fetch,
    });

    expect(issues.map((i) => i.identifier)).toEqual(["CYB-1", "CYB-251", "OCD-498"]);
    expect(issues.find((i) => i.identifier === "OCD-498")?.projectId).toBe("P-OCD-70");
  });

  it("Tier 2: uses orca linear list-issues when LINEAR_API_KEY is empty and CLI returns ok !== false", async () => {
    const config = loadPaperclipOrgsConfig({ configPath: CONFIG_PATH });
    const execSpy = vi.fn(async (_cmd: string, args: readonly string[]) => {
      if (args.includes("CYB")) {
        return JSON.stringify({
          ok: true,
          issues: [
            {
              id: "CYB-499",
              uuid: "00759768-9718-4028-b0e0-b58986d711ef",
              title: "Documentum RAG",
              url: "https://linear.app/cyber-sec/issue/CYB-499",
              priority: { value: 2 },
              status: "In Review",
              statusType: "started",
              projectId: "6f840a23-fb45-4e89-b95e-73bc4e4def4c",
              gitBranchName: "adibirzu/cyb-499",
            },
          ],
        });
      }
      return JSON.stringify({
        ok: true,
        issues: [
          {
            id: "OCD-500",
            uuid: "11111111-2222-3333-4444-555555555555",
            title: "RF05 Sandbox",
            url: "https://linear.app/cyber-sec/issue/OCD-500",
            priority: 1,
            status: "In Progress",
            statusType: "started",
            projectId: "c1ee7da9-3729-4f70-9225-922039ce4897",
          },
        ],
      });
    });

    const issues = await fetchLinearIssuesLive(config, {
      apiKey: "",
      env: {},
      boardEnvPath: join(tempRoot, "missing.env"),
      execFn: execSpy,
      cachePath: join(tempRoot, "unused-cache.json"),
    });

    expect(issues.map((i) => i.identifier)).toEqual(["CYB-499", "OCD-500"]);
    expect(issues[0]?.id).toBe("00759768-9718-4028-b0e0-b58986d711ef");
    expect(issues[0]?.branchName).toBe("adibirzu/cyb-499");
  });

  it("Tier 3: falls back to linear-issues-cache.json when LINEAR_API_KEY is empty and orca linear returns ok: false", async () => {
    const config = loadPaperclipOrgsConfig({ configPath: CONFIG_PATH });
    const cachePath = join(tempRoot, "linear-issues-cache.json");
    writeFileSync(
      cachePath,
      JSON.stringify({
        schemaVersion: "linear-issues-cache.v1",
        count: 3,
        issues: [
          {
            id: "CYB-499",
            uuid: "00759768-9718-4028-b0e0-b58986d711ef",
            title: "Bounded structural PDF/DOCX/XLSX parser",
            description: "RAG upgrade",
            priority: { value: 2, name: "High" },
            url: "https://linear.app/cyber-sec/issue/CYB-499",
            gitBranchName: "adibirzu/cyb-499",
            status: "In Review",
            statusType: "started",
            project: "Pentforge Documentum",
            projectId: "6f840a23-fb45-4e89-b95e-73bc4e4def4c",
            team: "Cyber-sec",
          },
          {
            id: "OCD-524",
            uuid: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
            title: "ReviewForge custody issue",
            description: "",
            priority: { value: 1, name: "Urgent" },
            url: "https://linear.app/cyber-sec/issue/OCD-524",
            gitBranchName: "wip/adrians-macbook-pro/ocd-524",
            status: "Backlog",
            statusType: "backlog",
            project: "ReviewForge — Automatic GitHub Code Review",
            projectId: "c1ee7da9-3729-4f70-9225-922039ce4897",
            team: "OCD",
          },
          {
            id: "CYB-299",
            uuid: "ffffffff-1111-2222-3333-444444444444",
            title: "Duplicate ticket",
            description: "",
            priority: { value: 0, name: "No priority" },
            url: "https://linear.app/cyber-sec/issue/CYB-299",
            status: "Duplicate",
            statusType: "duplicate",
            project: "FirstMate",
            projectId: "0660fe2f-23d4-43bf-9e2e-700ba8a57b99",
            team: "Cyber-sec",
          },
        ],
      }),
      "utf8",
    );

    const lockedOrcaExec = vi.fn(async () =>
      JSON.stringify({
        ok: false,
        error: { code: "linear_network_error", message: "Could not decrypt saved Linear credential" },
      }),
    );

    const issues = await fetchLinearIssuesLive(config, {
      apiKey: "",
      env: {},
      boardEnvPath: join(tempRoot, "missing.env"),
      execFn: lockedOrcaExec,
      cachePath,
    });

    expect(issues).toHaveLength(3);
    const cyb = issues.find((i) => i.identifier === "CYB-499");
    expect(cyb?.id).toBe("00759768-9718-4028-b0e0-b58986d711ef");
    expect(cyb?.projectId).toBe("P-CYB-71");
    expect(cyb?.priority).toBe(2);

    const ocd = issues.find((i) => i.identifier === "OCD-524");
    expect(ocd?.projectId).toBe("P-OCD-70");
    expect(ocd?.teamKey).toBe("OCD");

    const dup = issues.find((i) => i.identifier === "CYB-299");
    expect(dup?.stateType).toBe("canceled");
  });

  it("parallelizes fetchGitHubPrsLive with bounded concurrency <= 6 and handles headless updateLinearIssueStateLive gracefully", async () => {
    const repos = Array.from({ length: 18 }, (_, i) => `adibirzu/repo-${i + 1}`);
    let inFlight = 0;
    let maxInFlight = 0;

    const prs = await fetchGitHubPrsLive(repos, async (_cmd, args) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 15));
      inFlight -= 1;
      const repoName = args[3] ?? "adibirzu/repo-1";
      return JSON.stringify([
        {
          number: 1,
          title: `feat: CYB-${repoName.split("-").pop()}`,
          url: `https://github.com/${repoName}/pull/1`,
          state: "OPEN",
          headRefName: "feat/test",
          statusCheckRollup: [],
          body: "",
        },
      ]);
    });

    expect(prs).toHaveLength(18);
    expect(maxInFlight).toBeGreaterThan(1);
    expect(maxInFlight).toBeLessThanOrEqual(6);

    // Headless updateLinearIssueStateLive should not throw when no API key is set and orca linear is locked
    const config = loadPaperclipOrgsConfig({ configPath: CONFIG_PATH });
    await expect(
      updateLinearIssueStateLive("uuid-1", "In Review", config.controlPlane.linearTeam.uuid, {
        apiKey: "",
        env: {},
        boardEnvPath: join(tempRoot, "missing.env"),
        execFn: async () => JSON.stringify({ ok: false }),
      }),
    ).resolves.toBeUndefined();
  });

  it("skips creating Paperclip clutter for untracked historical completed/canceled issues while transitioning tracked ones", () => {
    const config = loadPaperclipOrgsConfig({ configPath: CONFIG_PATH });
    const plan = reconcileFourWay({
      orgsConfig: config,
      orgCompanyMap: {
        "cyb-01-fleet-harness": {
          companyId: "comp-01",
          projectsBySlug: { "orca-axi": "pcp-proj-orca" },
        },
      },
      linearIssues: [
        {
          id: "u-old-done",
          identifier: "CYB-10",
          title: "Historical completed issue",
          description: "",
          url: "https://linear.app/cyber-sec/issue/CYB-10",
          stateType: "completed",
          stateName: "Done",
          priority: 2,
          projectId: "P-CYB-73",
          projectUuid: "8ff1e728-4d61-42e4-9471-33bedb5d5cc9",
          projectName: "Orca & AXI Plugins",
          teamKey: "CYB",
          blockedBy: [],
        },
        {
          id: "u-canceled-tracked",
          identifier: "CYB-11",
          title: "Canceled after sync",
          description: "",
          url: "https://linear.app/cyber-sec/issue/CYB-11",
          stateType: "canceled",
          stateName: "Canceled",
          priority: 3,
          projectId: "P-CYB-73",
          projectUuid: "8ff1e728-4d61-42e4-9471-33bedb5d5cc9",
          projectName: "Orca & AXI Plugins",
          teamKey: "CYB",
          blockedBy: [],
        },
      ],
      paperclipIssuesByOrg: {
        "cyb-01-fleet-harness": [
          {
            id: "pcp-11",
            companyId: "comp-01",
            projectId: "pcp-proj-orca",
            title: "[CYB-11] Canceled after sync",
            status: "todo",
            priority: "medium",
          },
        ],
      },
      githubPrs: [
        {
          repo: "adibirzu/orca-axi",
          number: 1,
          title: "Old merged PR (CYB-10)",
          url: "https://github.com/adibirzu/orca-axi/pull/1",
          state: "MERGED",
          headRefName: "feat/old",
          ciState: "SUCCESS",
          linearIdentifiers: ["CYB-10"],
        },
      ],
      fmTasks: [],
      custody: {
        reviewforgeHost: "adrians-macbook-pro",
        fencedIssues: ["OCD-498"],
        adi0CompanionIssues: ["OCD-497"],
        activeBranches: [],
      },
      ledger: createEmptyLedger("2026-11-12T09:00:00Z"),
      now: "2026-11-12T10:00:00Z",
    });

    // CYB-10 was already completed in Linear and never tracked in Paperclip -> zero Paperclip creation clutter
    expect(plan.mutations.some((m) => m.linearIdentifier === "CYB-10")).toBe(false);
    // CYB-11 WAS tracked in Paperclip and became canceled in Linear -> transitions to cancelled
    expect(
      plan.mutations.some(
        (m) => m.linearIdentifier === "CYB-11" && m.targetStatus === "cancelled",
      ),
    ).toBe(true);
    expect(plan.mergedPrs).toHaveLength(1);
    expect(plan.openPrs).toHaveLength(0);
  });

  it("populates state/stateType/initiativeId on readyQueue items and transitions tracked completed issues to done", async () => {
    const config = loadPaperclipOrgsConfig({ configPath: CONFIG_PATH });
    const boardEnv = join(tempRoot, "cyb-board.env");
    writeFileSync(boardEnv, "LINEAR_API_KEY=stub\n", "utf8");

    const mockFetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          data: {
            issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
            project: { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } },
          },
        }),
        { status: 200 },
      ),
    );
    const fromEnvFile = await fetchLinearIssuesLive(config, {
      env: {},
      boardEnvPath: boardEnv,
      fetchImpl: mockFetch as unknown as typeof fetch,
    });
    expect(fromEnvFile).toEqual([]);
    expect(mockFetch).toHaveBeenCalled();

    const orcaSetSpy = vi.fn(async () => JSON.stringify({ ok: true }));
    await updateLinearIssueStateLive("CYB-77", "In Review", config.controlPlane.linearTeam.uuid, {
      apiKey: "",
      env: {},
      boardEnvPath: join(tempRoot, "missing.env"),
      execFn: orcaSetSpy,
    });
    expect(orcaSetSpy).toHaveBeenCalledWith("orca", [
      "linear",
      "status",
      "set",
      "CYB-77",
      "--to",
      "In Review",
      "--json",
    ]);

    const plan = reconcileFourWay({
      orgsConfig: config,
      orgCompanyMap: {
        "cyb-01-fleet-harness": {
          companyId: "comp-01",
          projectsBySlug: { firstmate: "pcp-proj-fm" },
        },
      },
      linearIssues: [
        {
          id: "u-todo",
          identifier: "CYB-88",
          title: "Ready Todo item",
          description: "",
          url: "https://linear.app/cyber-sec/issue/CYB-88",
          stateType: "unstarted",
          stateName: "Todo",
          priority: 2,
          projectId: "P-CYB-72",
          projectUuid: "0660fe2f-23d4-43bf-9e2e-700ba8a57b99",
          projectName: "FirstMate",
          teamKey: "CYB",
          blockedBy: [],
        },
        {
          id: "u-tracked-done",
          identifier: "CYB-89",
          title: "Tracked issue completed in Linear",
          description: "",
          url: "https://linear.app/cyber-sec/issue/CYB-89",
          stateType: "completed",
          stateName: "Done",
          priority: 2,
          projectId: "P-CYB-72",
          projectUuid: "0660fe2f-23d4-43bf-9e2e-700ba8a57b99",
          projectName: "FirstMate",
          teamKey: "CYB",
          blockedBy: [],
        },
      ],
      paperclipIssuesByOrg: {
        "cyb-01-fleet-harness": [
          {
            id: "pcp-89",
            companyId: "comp-01",
            projectId: "pcp-proj-fm",
            title: "[CYB-89] Tracked issue completed in Linear",
            status: "in_progress",
            priority: "high",
          },
        ],
      },
      githubPrs: [],
      fmTasks: [],
      custody: {
        reviewforgeHost: "adrians-macbook-pro",
        fencedIssues: [],
        adi0CompanionIssues: [],
        activeBranches: [],
      },
      ledger: createEmptyLedger("2026-11-12T09:00:00Z"),
      now: "2026-11-12T10:00:00Z",
    });

    expect(plan.readyQueue[0]).toMatchObject({
      linearIdentifier: "CYB-88",
      initiativeId: "I-3",
      state: "Todo",
      stateType: "unstarted",
    });
    expect(
      plan.mutations.some((m) => m.linearIdentifier === "CYB-89" && m.targetStatus === "done"),
    ).toBe(true);

    const activePlan = reconcileFourWay({
      orgsConfig: config,
      orgCompanyMap: {
        "cyb-01-fleet-harness": {
          companyId: "comp-01",
          firstmateAgentId: "193a6cbc-4592-4338-b91c-24d60456cc5c",
          projectsBySlug: { firstmate: "pcp-proj-fm" },
        },
      },
      linearIssues: [
        {
          id: "u-prog",
          identifier: "CYB-90",
          title: "Started work requiring assignee on Paperclip",
          description: "",
          url: "https://linear.app/cyber-sec/issue/CYB-90",
          stateType: "started",
          stateName: "In Progress",
          priority: 1,
          projectId: "P-CYB-72",
          projectUuid: "0660fe2f-23d4-43bf-9e2e-700ba8a57b99",
          projectName: "FirstMate",
          teamKey: "CYB",
          blockedBy: [],
        },
      ],
      paperclipIssuesByOrg: { "cyb-01-fleet-harness": [] },
      githubPrs: [],
      fmTasks: [],
      custody: {
        reviewforgeHost: "adrians-macbook-pro",
        fencedIssues: [],
        adi0CompanionIssues: [],
        activeBranches: [],
      },
      ledger: createEmptyLedger("2026-11-12T09:00:00Z"),
      now: "2026-11-12T10:00:00Z",
    });

    const progMut = activePlan.mutations.find((m) => m.linearIdentifier === "CYB-90");
    expect(progMut?.targetStatus).toBe("in_progress");
    expect(progMut?.assigneeAgentId).toBe("193a6cbc-4592-4338-b91c-24d60456cc5c");
  });
});
