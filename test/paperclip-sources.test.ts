import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadPaperclipOrgsConfig } from "../src/paperclip/policy.js";
import {
  extractIssueIdentifiers,
  fetchGitHubPrsLive,
  fetchLinearIssuesLive,
  loadCustodySnapshotLive,
  loadFirstMateTasks,
  loadInstanceMap,
  normalizeInstanceMap,
  parseFirstMateBacklog,
  saveInstanceMapAtomic,
  updateLinearIssueStateLive,
} from "../src/paperclip/sources.js";

const CONFIG_PATH = fileURLToPath(new URL("../config/paperclip-orgs.json", import.meta.url));

describe("paperclip sources & local-state parsers", () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "paperclip-sources-test-"));
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it("extracts CYB-* and OCD-* identifiers deduplicated and uppercase", () => {
    expect(extractIssueIdentifiers("Refs cyb-12, OCD-498, CYB-12 and RF03/ocd-500")).toEqual([
      "CYB-12",
      "OCD-498",
      "OCD-500",
    ]);
  });

  it("normalizes array and record instance map shapes and persists atomically", () => {
    const fromArray = normalizeInstanceMap({
      companies: [
        { slug: "cyb-01-fleet-harness", id: "comp-1" },
        { key: "cyb-02", companyId: "comp-2" },
      ],
    });
    expect(fromArray.organizations["cyb-01-fleet-harness"]?.companyId).toBe("comp-1");
    expect(fromArray.organizations["cyb-02"]?.companyId).toBe("comp-2");

    const fromStringRecord = normalizeInstanceMap({
      orgs: {
        "cyb-03-erp-finance": "comp-3",
        "cyb-04-ai-voice-apps": { id: "comp-4", projects: { atlas: "proj-atlas" } },
      },
    });
    expect(fromStringRecord.organizations["cyb-03-erp-finance"]?.companyId).toBe("comp-3");
    expect(fromStringRecord.organizations["cyb-04-ai-voice-apps"]?.projectsBySlug.atlas).toBe(
      "proj-atlas",
    );

    const mapPath = join(tempRoot, "paperclip-instance.json");
    expect(loadInstanceMap(mapPath).organizations).toEqual({});
    saveInstanceMapAtomic(fromStringRecord, mapPath);
    expect(loadInstanceMap(mapPath).organizations["cyb-03-erp-finance"]?.companyId).toBe("comp-3");

    // Verify non-destructive merge when Stream A array + orgsBySlug structure exists
    writeFileSync(
      mapPath,
      JSON.stringify({
        schemaVersion: 1,
        primaryUrl: "https://adi5.tailb55406.ts.net:9448",
        organizations: [
          {
            slug: "cyb-01-fleet-harness",
            code: "CYB01",
            companyId: "comp-1",
            firstmateAgentId: "agent-1",
          },
        ],
        orgsBySlug: {
          "cyb-01-fleet-harness": {
            slug: "cyb-01-fleet-harness",
            companyId: "comp-1",
            firstmateAgentId: "agent-1",
          },
        },
      }),
      "utf8",
    );
    saveInstanceMapAtomic(
      {
        schemaVersion: "paperclip-instance.v1",
        updatedAt: "2026-11-12T09:10:00Z",
        organizations: {
          "cyb-01-fleet-harness": {
            companyId: "comp-1",
            projectsBySlug: { "orca-axi": "proj-orca" },
          },
        },
      },
      mapPath,
    );
    const merged = loadInstanceMap(mapPath);
    expect(merged.apiBase).toBe("https://adi5.tailb55406.ts.net:9448");
    expect(merged.organizations["cyb-01-fleet-harness"]?.firstmateAgentId).toBe("agent-1");
    expect(merged.organizations["cyb-01-fleet-harness"]?.projectsBySlug["orca-axi"]).toBe(
      "proj-orca",
    );
  });

  it("parses FirstMate backlog.md and state/*.meta files into task snapshots", () => {
    const fmHome = join(tempRoot, "fm");
    mkdirSync(join(fmHome, "data"), { recursive: true });
    mkdirSync(join(fmHome, "state"), { recursive: true });

    const backlogMd = [
      "# Backlog",
      "",
      "## In flight",
      "- [ ] fm-task-1 - Ship CYB-301 adapter (repo: firstmate) (kind: ship)",
      "  Extra details referencing CYB-302",
      "- [ ] fm-held-2 - Held OCD-497 task (repo: reviewforge) (hold: waiting on review)",
      "## Queued",
      "- [ ] fm-queued-3 - Queued CYB-305 cleanup (repo: orca-axi)",
      "## Completed",
      "- [x] old-task - Ignored",
    ].join("\n");

    writeFileSync(join(fmHome, "data", "backlog.md"), backlogMd, "utf8");
    writeFileSync(
      join(fmHome, "state", "fm-task-1.meta"),
      "endpoint_task_id=fm-task-1\nworktree=/tmp/wt1\nharness=codex\n",
      "utf8",
    );
    writeFileSync(
      join(fmHome, "state", "meta-only.meta"),
      "endpoint_task_id=meta-only\nprojects=aetherops\nharness=grok\nnote=CYB-399\n",
      "utf8",
    );

    const parsedOnly = parseFirstMateBacklog(backlogMd);
    expect(parsedOnly).toHaveLength(3);
    expect(parsedOnly[1]?.status).toBe("held");

    const tasks = loadFirstMateTasks(fmHome);
    const t1 = tasks.find((t) => t.taskId === "fm-task-1");
    expect(t1?.worktree).toBe("/tmp/wt1");
    expect(t1?.harness).toBe("codex");
    expect(t1?.linearIdentifiers).toEqual(["CYB-301", "CYB-302"]);

    const metaOnly = tasks.find((t) => t.taskId === "meta-only");
    expect(metaOnly?.linearIdentifiers).toEqual(["CYB-399"]);
  });

  it("loads custody snapshot via rf-mac-sync JSON output and falls back cleanly on error", async () => {
    const config = loadPaperclipOrgsConfig({ configPath: CONFIG_PATH });
    const custody = await loadCustodySnapshotLive(config, {
      execFn: async () =>
        JSON.stringify({
          hosts: [
            {
              host: "adrians-macbook-pro",
              active_issues: ["RF03/OCD-498", "OCD-599"],
            },
          ],
          primary_clone: { branch: "wip/adrians-macbook-pro/rf09" },
        }),
    });
    expect(custody.fencedIssues).toContain("OCD-599");
    expect(custody.activeBranches).toEqual(["wip/adrians-macbook-pro/rf09"]);

    const fallback = await loadCustodySnapshotLive(config, {
      execFn: async () => {
        throw new Error("offline");
      },
    });
    expect(fallback.fencedIssues).toContain("OCD-498");
  });

  it("parses GitHub PR check rollups and Linear GraphQL responses", async () => {
    const prs = await fetchGitHubPrsLive(["adibirzu/orca-axi"], async () =>
      JSON.stringify([
        {
          number: 8,
          title: "feat: CYB-401 sync",
          url: "https://github.com/adibirzu/orca-axi/pull/8",
          state: "OPEN",
          headRefName: "feat/cyb-401",
          statusCheckRollup: [{ conclusion: "SUCCESS" }],
          body: "Fixes CYB-401",
        },
        {
          number: 9,
          title: "feat: CYB-402 broken",
          url: "https://github.com/adibirzu/orca-axi/pull/9",
          state: "OPEN",
          headRefName: "feat/cyb-402",
          statusCheckRollup: [{ conclusion: "FAILURE" }],
          body: "",
        },
      ]),
    );
    expect(prs).toHaveLength(2);
    expect(prs[0]?.ciState).toBe("SUCCESS");
    expect(prs[1]?.ciState).toBe("FAILURE");

    const config = loadPaperclipOrgsConfig({ configPath: CONFIG_PATH });
    const mockLinearFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (String(body.query).includes("TeamIssues")) {
        return new Response(
          JSON.stringify({
            data: {
              issues: {
                nodes: [
                  {
                    id: "lin-uuid-401",
                    identifier: "CYB-401",
                    title: "Test GraphQL",
                    description: "Body",
                    url: "https://linear.app/cyber-sec/issue/CYB-401",
                    priority: 1,
                    branchName: "feat/cyb-401",
                    state: { name: "Todo", type: "unstarted" },
                    project: {
                      id: "8ff1e728-4d61-42e4-9471-33bedb5d5cc9",
                      name: "Orca & AXI Plugins",
                    },
                    inverseRelations: {
                      nodes: [
                        {
                          type: "blocks",
                          issue: { identifier: "CYB-400", state: { type: "started" } },
                        },
                      ],
                    },
                  },
                ],
              },
            },
          }),
          { status: 200 },
        );
      }
      if (String(body.query).includes("WorkflowStates")) {
        return new Response(
          JSON.stringify({
            data: {
              workflowStates: {
                nodes: [{ id: "st-done", name: "Done", type: "completed" }],
              },
            },
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({ data: { issueUpdate: { success: true } } }),
        { status: 200 },
      );
    });

    const issues = await fetchLinearIssuesLive(config, {
      apiKey: "lin_test_key",
      fetchImpl: mockLinearFetch as unknown as typeof fetch,
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.blockedBy).toEqual(["CYB-400"]);

    await updateLinearIssueStateLive(
      "lin-uuid-401",
      "Done",
      config.controlPlane.linearTeam.uuid,
      { apiKey: "lin_test_key", fetchImpl: mockLinearFetch as unknown as typeof fetch },
    );
    expect(mockLinearFetch).toHaveBeenCalledTimes(4);
  });
});
