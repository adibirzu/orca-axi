import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { createEmptyLedger, upsertLedgerEntry } from "../src/paperclip/ledger.js";
import { loadPaperclipOrgsConfig } from "../src/paperclip/policy.js";
import { reconcileFourWay } from "../src/paperclip/reconciler.js";
import type {
  CustodySnapshot,
  FirstMateTaskSnapshot,
  GitHubPrRollup,
  LinearIssueSnapshot,
  PaperclipIssue,
} from "../src/paperclip/types.js";

const CONFIG_PATH = fileURLToPath(new URL("../config/paperclip-orgs.json", import.meta.url));

describe("4-way deterministic reconciler", () => {
  const config = loadPaperclipOrgsConfig({ configPath: CONFIG_PATH });
  const orgCompanyMap = {
    "cyb-01-fleet-harness": {
      companyId: "comp-01",
      projectsBySlug: {
        "orca-axi": "pcp-proj-orca",
        firstmate: "pcp-proj-fm",
        reviewforge: "pcp-proj-rf",
      },
    },
    "cyb-05-cloud-infra": {
      companyId: "comp-05",
      projectsBySlug: {
        aetherops: "pcp-proj-ao",
      },
    },
  };

  const baseCustody: CustodySnapshot = {
    reviewforgeHost: "adrians-macbook-pro",
    fencedIssues: ["OCD-498", "OCD-500"],
    adi0CompanionIssues: ["OCD-497", "OCD-553"],
    activeBranches: ["wip/adrians-macbook-pro/rf03-bootstrap"],
  };

  it("reconciles merged PRs, open PRs, fenced custody, active FirstMate tasks, and unblocked Todo items", () => {
    const linearIssues: LinearIssueSnapshot[] = [
      {
        id: "lin-1",
        identifier: "CYB-101",
        title: "Portfolio command polish",
        description: "Ship portfolio command",
        url: "https://linear.app/cyber-sec/issue/CYB-101",
        stateType: "started",
        stateName: "In Review",
        priority: 1,
        projectId: "P-CYB-73",
        projectUuid: "8ff1e728-4d61-42e4-9471-33bedb5d5cc9",
        projectName: "Orca & AXI Plugins",
        teamKey: "CYB",
        blockedBy: [],
      },
      {
        id: "lin-2",
        identifier: "CYB-102",
        title: "Paperclip sync engine",
        description: "Implement 4-way sync",
        url: "https://linear.app/cyber-sec/issue/CYB-102",
        stateType: "started",
        stateName: "In Progress",
        priority: 1,
        projectId: "P-CYB-73",
        projectUuid: "8ff1e728-4d61-42e4-9471-33bedb5d5cc9",
        projectName: "Orca & AXI Plugins",
        teamKey: "CYB",
        blockedBy: [],
      },
      {
        id: "lin-3",
        identifier: "OCD-498",
        title: "RF03 Core ReviewForge Pipeline",
        description: "Owned by adrians-macbook-pro",
        url: "https://linear.app/cyber-sec/issue/OCD-498",
        stateType: "started",
        stateName: "In Progress",
        priority: 1,
        projectId: "P-OCD-70",
        projectUuid: "reviewforge-automatic-github-code-review-4bed8226ecec",
        projectName: "ReviewForge — Automatic GitHub Code Review",
        teamKey: "OCD",
        blockedBy: [],
      },
      {
        id: "lin-4",
        identifier: "CYB-104",
        title: "Live scanner guard",
        description: "In flight in FirstMate",
        url: "https://linear.app/cyber-sec/issue/CYB-104",
        stateType: "unstarted",
        stateName: "Todo",
        priority: 1,
        projectId: "P-CYB-2",
        projectUuid: "3655151e-8fb1-44ae-891b-8561a0e13113",
        projectName: "AetherOps",
        teamKey: "CYB",
        blockedBy: [],
      },
      {
        id: "lin-5",
        identifier: "CYB-105",
        title: "Add wake event bridge",
        description: "Unblocked ready work",
        url: "https://linear.app/cyber-sec/issue/CYB-105",
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
        id: "lin-6",
        identifier: "CYB-106",
        title: "Higher priority unblocked work",
        description: "Urgent task",
        url: "https://linear.app/cyber-sec/issue/CYB-106",
        stateType: "backlog",
        stateName: "Backlog",
        priority: 1,
        projectId: "P-CYB-72",
        projectUuid: "0660fe2f-23d4-43bf-9e2e-700ba8a57b99",
        projectName: "FirstMate",
        teamKey: "CYB",
        blockedBy: [],
      },
    ];

    const githubPrs: GitHubPrRollup[] = [
      {
        repo: "adibirzu/orca-axi",
        number: 5,
        title: "feat: portfolio domain catalog (CYB-101)",
        url: "https://github.com/adibirzu/orca-axi/pull/5",
        state: "MERGED",
        headRefName: "feat/portfolio-domain-catalog",
        ciState: "SUCCESS",
        linearIdentifiers: ["CYB-101"],
        mergedAt: "2026-11-12T08:10:00Z",
      },
      {
        repo: "adibirzu/orca-axi",
        number: 6,
        title: "feat: paperclip sync engine (CYB-102)",
        url: "https://github.com/adibirzu/orca-axi/pull/6",
        state: "OPEN",
        headRefName: "feat/paperclip-cyb-sync-engine",
        ciState: "SUCCESS",
        linearIdentifiers: ["CYB-102"],
      },
    ];

    const fmTasks: FirstMateTaskSnapshot[] = [
      {
        taskId: "ap-07-execution-live-guard",
        title: "CYB-104 Enforce live scanner guard",
        repo: "aetherops",
        status: "in_flight",
        linearIdentifiers: ["CYB-104"],
        harness: "grok",
      },
    ];

    const paperclipIssuesByOrg: Record<string, readonly PaperclipIssue[]> = {
      "cyb-01-fleet-harness": [
        {
          id: "pcp-iss-101",
          companyId: "comp-01",
          projectId: "pcp-proj-orca",
          title: "[CYB-101] Portfolio command polish",
          status: "in_review",
          priority: "critical",
        },
      ],
      "cyb-05-cloud-infra": [],
    };

    const plan = reconcileFourWay({
      orgsConfig: config,
      orgCompanyMap,
      linearIssues,
      paperclipIssuesByOrg,
      githubPrs,
      fmTasks,
      custody: baseCustody,
      ledger: createEmptyLedger("2026-11-12T08:00:00Z"),
      now: "2026-11-12T08:50:00Z",
    });

    // Rule 1: Merged PR -> Linear Done + Paperclip done + fleetSyncRepos
    expect(plan.fleetSyncRepos).toContain("adibirzu/orca-axi");
    const m101 = plan.mutations.filter((m) => m.linearIdentifier === "CYB-101");
    expect(m101.some((m) => m.target === "linear" && m.targetStatus === "Done")).toBe(true);
    expect(
      m101.some(
        (m) =>
          m.target === "paperclip" &&
          m.action === "update" &&
          m.paperclipIssueId === "pcp-iss-101" &&
          m.targetStatus === "done",
      ),
    ).toBe(true);

    // Rule 2: Open PR -> Linear In Review + Paperclip in_review with PR URL & CI state
    const m102 = plan.mutations.filter((m) => m.linearIdentifier === "CYB-102");
    expect(m102.some((m) => m.target === "linear" && m.targetStatus === "In Review")).toBe(true);
    const pcp102 = m102.find((m) => m.target === "paperclip");
    expect(pcp102?.targetStatus).toBe("in_review");
    expect(pcp102?.description).toContain("https://github.com/adibirzu/orca-axi/pull/6");
    expect(pcp102?.description).toContain("SUCCESS");

    // Rule 3: Active adrians-macbook-pro custody -> fenced, Paperclip blocked, NEVER in readyQueue, zero Linear mutation
    const mOcd = plan.mutations.filter((m) => m.linearIdentifier === "OCD-498");
    expect(mOcd.some((m) => m.target === "linear")).toBe(false);
    const pcpOcd = mOcd.find((m) => m.target === "paperclip");
    expect(pcpOcd?.targetStatus).toBe("blocked");
    expect(pcpOcd?.fencedBy).toBe("adrians-macbook-pro");
    expect(plan.fencedItems.map((f) => f.linearIdentifier)).toContain("OCD-498");
    expect(plan.readyQueue.map((r) => r.linearIdentifier)).not.toContain("OCD-498");

    // Rule 4: Active FirstMate task -> Linear In Progress + Paperclip in_progress, excluded from readyQueue
    const m104 = plan.mutations.filter((m) => m.linearIdentifier === "CYB-104");
    expect(m104.some((m) => m.target === "linear" && m.targetStatus === "In Progress")).toBe(true);
    expect(m104.some((m) => m.target === "paperclip" && m.targetStatus === "in_progress")).toBe(
      true,
    );
    expect(plan.readyQueue.map((r) => r.linearIdentifier)).not.toContain("CYB-104");

    // Rule 5: Unblocked Todo/Backlog -> upserted to Paperclip & ranked in readyQueue (CYB-106 priority 1 before CYB-105 priority 2)
    expect(plan.readyQueue.map((r) => r.linearIdentifier)).toEqual(["CYB-106", "CYB-105"]);
  });

  it("guarantees zero duplicate Paperclip creations and zero no-op mutations on replay", () => {
    const linearIssue: LinearIssueSnapshot = {
      id: "lin-5",
      identifier: "CYB-105",
      title: "Add wake event bridge",
      description: "Unblocked ready work",
      url: "https://linear.app/cyber-sec/issue/CYB-105",
      stateType: "unstarted",
      stateName: "Todo",
      priority: 2,
      projectId: "P-CYB-72",
      projectUuid: "0660fe2f-23d4-43bf-9e2e-700ba8a57b99",
      projectName: "FirstMate",
      teamKey: "CYB",
      blockedBy: [],
    };

    // First run creates planned ledger entry hash
    const firstPlan = reconcileFourWay({
      orgsConfig: config,
      orgCompanyMap,
      linearIssues: [linearIssue],
      paperclipIssuesByOrg: { "cyb-01-fleet-harness": [] },
      githubPrs: [],
      fmTasks: [],
      custody: baseCustody,
      ledger: createEmptyLedger("2026-11-12T08:00:00Z"),
      now: "2026-11-12T08:50:00Z",
    });

    expect(firstPlan.mutations).toHaveLength(1);
    expect(firstPlan.mutations[0]?.action).toBe("create");
    const plannedHash = firstPlan.mutations[0]!.contentHash;

    // Simulate applied state in Paperclip + Ledger
    const syncedLedger = upsertLedgerEntry(
      createEmptyLedger("2026-11-12T08:50:00Z"),
      {
        linearIdentifier: "CYB-105",
        orgSlug: "cyb-01-fleet-harness",
        paperclipCompanyId: "comp-01",
        paperclipProjectId: "pcp-proj-fm",
        paperclipIssueId: "pcp-iss-105",
        lastPaperclipStatus: "todo",
        contentHash: plannedHash,
        updatedAt: "2026-11-12T08:50:00Z",
      },
      "2026-11-12T08:50:00Z",
    );

    const replayPlan = reconcileFourWay({
      orgsConfig: config,
      orgCompanyMap,
      linearIssues: [linearIssue],
      paperclipIssuesByOrg: {
        "cyb-01-fleet-harness": [
          {
            id: "pcp-iss-105",
            companyId: "comp-01",
            projectId: "pcp-proj-fm",
            title: "[CYB-105] Add wake event bridge",
            status: "todo",
            priority: "high",
          },
        ],
      },
      githubPrs: [],
      fmTasks: [],
      custody: baseCustody,
      ledger: syncedLedger,
      now: "2026-11-12T08:55:00Z",
    });

    expect(replayPlan.mutations).toHaveLength(0);
    expect(replayPlan.readyQueue).toHaveLength(1);
  });
});
