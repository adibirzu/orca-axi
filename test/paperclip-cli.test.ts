import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runPaperclipCybCli } from "../src/paperclip/cli.js";
import type { PaperclipCliDeps } from "../src/paperclip/ops.js";

const CONFIG_PATH = fileURLToPath(new URL("../config/paperclip-orgs.json", import.meta.url));

describe("paperclip-cyb CLI subcommands", () => {
  let tempRoot: string;
  let ledgerPath: string;
  let instanceMapPath: string;
  let boardEnvPath: string;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "paperclip-cli-test-"));
    ledgerPath = join(tempRoot, "ledger.json");
    instanceMapPath = join(tempRoot, "paperclip-instance.json");
    boardEnvPath = join(tempRoot, "cyb-board.env");
    writeFileSync(
      boardEnvPath,
      "PAPERCLIP_API_BASE=https://adi5.tailb55406.ts.net:9448\nPAPERCLIP_API_KEY=pcp_test_token\n",
      { mode: 0o600 },
    );
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  function createMockDeps(): {
    deps: PaperclipCliDeps;
    stdout: string[];
    stderr: string[];
    createdCompanies: string[];
    updatedIssues: Array<{ id: string; status?: string }>;
  } {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const createdCompanies: string[] = [];
    const updatedIssues: Array<{ id: string; status?: string }> = [];

    const companies = [
      {
        id: "comp-01",
        name: "01 — Fleet, Harness² & Developer Platform",
        description: "slug:cyb-01-fleet-harness | initiative:I-3",
        status: "active" as const,
        budgetMonthlyCents: 0,
      },
    ];

    const client = {
      health: vi.fn(async () => ({
        status: "ok" as const,
        deploymentMode: "authenticated",
        deploymentExposure: "private",
        version: "0.4.0",
      })),
      listCompanies: vi.fn(async () => companies),
      createCompany: vi.fn(async (input: { name: string; description?: string }) => {
        createdCompanies.push(input.name);
        return {
          id: `comp-${createdCompanies.length + 1}`,
          name: input.name,
          description: input.description,
          status: "active" as const,
          budgetMonthlyCents: 0,
        };
      }),
      updateCompany: vi.fn(async (id: string, patch: { name?: string; description?: string }) => ({
        id,
        name: patch.name ?? "Updated",
        description: patch.description,
        status: "active" as const,
        budgetMonthlyCents: 0,
      })),
      listProjects: vi.fn(async () => [
        {
          id: "pcp-proj-orca",
          companyId: "comp-01",
          name: "Orca & AXI Plugins",
          status: "in_progress",
        },
      ]),
      createProject: vi.fn(async (companyId: string, input: { name: string }) => ({
        id: `proj-${input.name}`,
        companyId,
        name: input.name,
        status: "in_progress",
      })),
      updateProject: vi.fn(async (id: string, patch: { name?: string }) => ({
        id,
        companyId: "comp-01",
        name: patch.name ?? "Updated",
        status: "in_progress",
      })),
      listIssues: vi.fn(async () => [
        {
          id: "pcp-iss-200",
          companyId: "comp-01",
          projectId: "pcp-proj-orca",
          title: "[CYB-200] Wire doctor check",
          status: "todo" as const,
          priority: "high" as const,
        },
      ]),
      getIssue: vi.fn(async (id: string) => ({
        id,
        companyId: "comp-01",
        projectId: "pcp-proj-orca",
        title: "[CYB-200] Wire doctor check",
        status: "todo" as const,
        priority: "high" as const,
      })),
      createIssue: vi.fn(async (companyId: string, input: { title: string; status?: any; priority?: any; projectId?: string }) => ({
        id: "pcp-iss-new",
        companyId,
        projectId: input.projectId,
        title: input.title,
        status: input.status ?? "todo",
        priority: input.priority ?? "medium",
      })),
      updateIssue: vi.fn(async (id: string, patch: { status?: any }) => {
        updatedIssues.push({ id, status: patch.status });
        return {
          id,
          companyId: "comp-01",
          projectId: "pcp-proj-orca",
          title: "[CYB-200] Wire doctor check",
          status: patch.status ?? "in_progress",
          priority: "high" as const,
        };
      }),
      addIssueComment: vi.fn(async () => ({ id: "cmt-1" })),
      listActivity: vi.fn(async () => [
        {
          id: "act-99",
          action: "issue.created",
          entityType: "issue",
          entityId: "pcp-iss-200",
          createdAt: "2026-11-12T09:00:00Z",
        },
      ]),
    };

    const deps: PaperclipCliDeps = {
      configPath: CONFIG_PATH,
      ledgerPath,
      instanceMapPath,
      boardEnvPath,
      fmHome: tempRoot,
      client: client as any,
      fetchLinearIssues: vi.fn(async () => [
        {
          id: "lin-200",
          identifier: "CYB-200",
          title: "Wire doctor check",
          description: "Doctor check spec",
          url: "https://linear.app/cyber-sec/issue/CYB-200",
          stateType: "unstarted" as const,
          stateName: "Todo",
          priority: 2,
          projectId: "P-CYB-73",
          projectUuid: "8ff1e728-4d61-42e4-9471-33bedb5d5cc9",
          projectName: "Orca & AXI Plugins",
          teamKey: "CYB",
          blockedBy: [],
        },
      ]),
      updateLinearIssueState: vi.fn(async () => undefined),
      fetchGitHubPrs: vi.fn(async () => []),
      loadFirstMateTasks: vi.fn(() => []),
      loadCustodySnapshot: vi.fn(async () => ({
        reviewforgeHost: "adrians-macbook-pro",
        fencedIssues: ["OCD-498"],
        adi0CompanionIssues: ["OCD-497", "OCD-553"],
        activeBranches: [],
      })),
      writeStdout: (s: string) => stdout.push(s),
      writeStderr: (s: string) => stderr.push(s),
      now: () => "2026-11-12T09:05:00Z",
    };

    return { deps, stdout, stderr, createdCompanies, updatedIssues };
  }

  it("runs doctor --json and reports health, config, and governance status", async () => {
    const { deps, stdout } = createMockDeps();
    const code = await runPaperclipCybCli(["doctor", "--json"], deps);
    expect(code).toBe(0);
    const payload = JSON.parse(stdout.join(""));
    expect(payload.success).toBe(true);
    expect(payload.data.organizationsCount).toBe(6);
    expect(payload.data.projectsCount).toBe(30);
    expect(payload.data.apiHealth.status).toBe("ok");
  });

  it("bootstraps missing orgs & projects in --dry-run and --apply modes idempotently", async () => {
    const { deps, stdout, createdCompanies } = createMockDeps();
    const dryCode = await runPaperclipCybCli(["orgs", "bootstrap", "--dry-run", "--json"], deps);
    expect(dryCode).toBe(0);
    expect(createdCompanies).toHaveLength(0);
    const dryPayload = JSON.parse(stdout.join(""));
    expect(dryPayload.data.mode).toBe("dry-run");
    expect(dryPayload.data.plannedOrgsToCreate).toBe(5);

    stdout.length = 0;
    const applyCode = await runPaperclipCybCli(["orgs", "bootstrap", "--apply", "--json"], deps);
    expect(applyCode).toBe(0);
    expect(createdCompanies).toHaveLength(5);
    const applyPayload = JSON.parse(stdout.join(""));
    expect(applyPayload.data.mode).toBe("apply");
  });

  it("evaluates guard-dispatch and returns exit code 0 when allowed and 2 when blocked", async () => {
    const { deps, stdout } = createMockDeps();
    const blockedCode = await runPaperclipCybCli(
      ["guard-dispatch", "--project", "aetherops", "--host", "adi0", "--harness", "agy", "--json"],
      deps,
    );
    expect(blockedCode).toBe(2);
    const blocked = JSON.parse(stdout.join(""));
    expect(blocked.data.allowed).toBe(false);
    expect(blocked.data.code).toBe("FORBIDDEN_HARNESS");

    stdout.length = 0;
    const allowedCode = await runPaperclipCybCli(
      ["guard-dispatch", "--project", "aetherops", "--host", "adi0", "--harness", "grok", "--json"],
      deps,
    );
    expect(allowedCode).toBe(0);
    const allowed = JSON.parse(stdout.join(""));
    expect(allowed.data.allowed).toBe(true);
  });

  it("runs sync, claim, report-pr, and watch-events --once cleanly", async () => {
    const { deps, stdout, updatedIssues } = createMockDeps();

    // 1. Bootstrap org map first so sync has company IDs
    await runPaperclipCybCli(["orgs", "bootstrap", "--apply", "--json"], deps);
    stdout.length = 0;

    // 2. Sync --apply
    const syncCode = await runPaperclipCybCli(
      ["sync", "--project", "orca-axi", "--apply", "--json"],
      deps,
    );
    expect(syncCode).toBe(0);
    const syncOut = JSON.parse(stdout.join(""));
    expect(syncOut.success).toBe(true);
    expect(syncOut.data.readyQueue).toHaveLength(1);
    expect(syncOut.data.readyQueue[0].linearIdentifier).toBe("CYB-200");
    stdout.length = 0;

    // 3. Claim CYB-200
    const claimCode = await runPaperclipCybCli(
      [
        "claim",
        "CYB-200",
        "--fm-task",
        "fm-cyb-200",
        "--worktree",
        "/Users/adrianb/orca/worktrees/cyb-200",
        "--harness",
        "codex",
        "--json",
      ],
      deps,
    );
    expect(claimCode).toBe(0);
    const claimOut = JSON.parse(stdout.join(""));
    expect(claimOut.data.entry.fmTaskId).toBe("fm-cyb-200");
    expect(updatedIssues.some((u) => u.id === "pcp-iss-200" && u.status === "in_progress")).toBe(
      true,
    );
    stdout.length = 0;

    // 4. Report PR on CYB-200
    const prCode = await runPaperclipCybCli(
      [
        "report-pr",
        "CYB-200",
        "--pr",
        "https://github.com/adibirzu/orca-axi/pull/7",
        "--ci",
        "SUCCESS",
        "--json",
      ],
      deps,
    );
    expect(prCode).toBe(0);
    const prOut = JSON.parse(stdout.join(""));
    expect(prOut.data.entry.githubPrUrl).toBe("https://github.com/adibirzu/orca-axi/pull/7");
    expect(updatedIssues.some((u) => u.id === "pcp-iss-200" && u.status === "in_review")).toBe(
      true,
    );
    stdout.length = 0;

    // 5. Watch-events --once (first call sees act-99 and advances cursor)
    const watchCode = await runPaperclipCybCli(["watch-events", "--once", "--json"], deps);
    expect(watchCode).toBe(0);
    const watchOut = JSON.parse(stdout.join(""));
    expect(watchOut.data.wake).toBe(true);
    expect(watchOut.data.events).toHaveLength(1);
    stdout.length = 0;

    // 6. Second watch-events --once sees nothing newer -> wake: false
    const watchIdleCode = await runPaperclipCybCli(["watch-events", "--once"], deps);
    expect(watchIdleCode).toBe(0);
    const watchIdle = JSON.parse(stdout.join(""));
    expect(watchIdle.data.wake).toBe(false);
    stdout.length = 0;

    // 7. Human mode (--help, doctor without --json, unknown subcommand, missing args)
    expect(await runPaperclipCybCli(["--help"], deps)).toBe(0);
    expect(stdout.join("")).toContain("Usage:");
    stdout.length = 0;

    expect(await runPaperclipCybCli(["doctor"], deps)).toBe(0);
    expect(stdout.join("")).toContain("paperclip-cyb doctor:");
    stdout.length = 0;

    expect(await runPaperclipCybCli(["guard-dispatch", "--project", "orca-axi"], deps)).toBe(1);
    expect(await runPaperclipCybCli(["claim", "CYB-200"], deps)).toBe(1);
    expect(await runPaperclipCybCli(["report-pr", "CYB-200"], deps)).toBe(1);
    expect(await runPaperclipCybCli(["unknown-cmd", "--json"], deps)).toBe(1);
  });
});
