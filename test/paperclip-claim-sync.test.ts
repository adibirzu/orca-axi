import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createEmptyLedger, loadLedger, saveLedgerAtomic, upsertLedgerEntry } from "../src/paperclip/ledger.js";
import { runSyncOp } from "../src/paperclip/ops.js";
import { runClaimOp, runReportPrOp } from "../src/paperclip/ops-workflow.js";
import { loadPaperclipOrgsConfig } from "../src/paperclip/policy.js";
import { reconcileFourWay } from "../src/paperclip/reconciler.js";
import type {
  CustodySnapshot,
  LinearIssueSnapshot,
  PaperclipIssue,
  SyncLedger,
} from "../src/paperclip/types.js";

const CONFIG_PATH = fileURLToPath(new URL("../config/paperclip-orgs.json", import.meta.url));

const IDENTIFIER = "CYB-105";
const LINEAR_TITLE = "Add wake event bridge";
const BOARD_TITLE = "[CYB-105] Add wake event bridge";
const LINEAR_PRIORITY = 4;
const BOARD_PRIORITY = "low" as const;
const PR_URL = "https://github.com/adibirzu/orca-axi/pull/105";

const custody: CustodySnapshot = {
  reviewforgeHost: "adrians-macbook-pro",
  fencedIssues: [],
  adi0CompanionIssues: [],
  activeBranches: [],
};

function linearIssue(stateName: string, stateType: LinearIssueSnapshot["stateType"]): LinearIssueSnapshot {
  return {
    id: "lin-105",
    identifier: IDENTIFIER,
    title: LINEAR_TITLE,
    description: "Wake the sync loop",
    url: "https://linear.app/cyber-sec/issue/CYB-105",
    stateType,
    stateName,
    priority: LINEAR_PRIORITY,
    projectId: "P-CYB-72",
    projectUuid: "0660fe2f-23d4-43bf-9e2e-700ba8a57b99",
    projectName: "FirstMate",
    teamKey: "CYB",
    blockedBy: [],
  };
}

function boardIssue(status: PaperclipIssue["status"]): PaperclipIssue {
  return {
    id: "pcp-iss-105",
    companyId: "comp-01",
    projectId: "pcp-proj-fm",
    title: BOARD_TITLE,
    status,
    priority: BOARD_PRIORITY,
  };
}

describe("claim and report-pr stay aligned with the next sync", () => {
  const config = loadPaperclipOrgsConfig({ configPath: CONFIG_PATH });
  let tempRoot: string;
  let ledgerPath: string;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "paperclip-claim-sync-"));
    ledgerPath = join(tempRoot, "ledger.json");
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  function seedLedger(): void {
    saveLedgerAtomic(
      upsertLedgerEntry(createEmptyLedger("2026-11-12T08:00:00Z"), {
        linearIdentifier: IDENTIFIER,
        orgSlug: "cyb-01-fleet-harness",
        paperclipCompanyId: "comp-01",
        paperclipProjectId: "pcp-proj-fm",
        paperclipIssueId: "pcp-iss-105",
        lastPaperclipStatus: "todo",
        contentHash: "seed-hash",
        updatedAt: "2026-11-12T08:00:00Z",
      }),
      { ledgerPath },
    );
  }

  function paperclipMutations(ledger: SyncLedger, issue: LinearIssueSnapshot, board: PaperclipIssue) {
    const plan = reconcileFourWay({
      orgsConfig: config,
      orgCompanyMap: {
        "cyb-01-fleet-harness": {
          companyId: "comp-01",
          projectsBySlug: { firstmate: "pcp-proj-fm" },
        },
      },
      linearIssues: [issue],
      paperclipIssuesByOrg: { "cyb-01-fleet-harness": [board] },
      githubPrs:
        board.status === "in_review"
          ? [
              {
                repo: "adibirzu/orca-axi",
                number: 105,
                title: "feat: wake bridge (CYB-105)",
                url: PR_URL,
                state: "OPEN",
                headRefName: "feat/wake-bridge",
                ciState: "SUCCESS",
                linearIdentifiers: [IDENTIFIER],
              },
            ]
          : [],
      fmTasks: [
        {
          taskId: "fm-105",
          title: "CYB-105 wake bridge",
          status: "in_flight",
          linearIdentifiers: [IDENTIFIER],
          worktree: join(tempRoot, "wt"),
          harness: "codex",
        },
      ],
      custody,
      ledger,
      now: "2026-11-12T09:00:00Z",
    });
    return plan.mutations.filter((mutation) => mutation.target === "paperclip");
  }

  it("hashes the board title and mapped priority so the next sync does not patch Paperclip", async () => {
    seedLedger();
    const updateIssue = vi.fn(async (id: string, patch: { status?: PaperclipIssue["status"] }) =>
      boardIssue(patch.status ?? "todo"),
    );
    const deps = {
      configPath: CONFIG_PATH,
      ledgerPath,
      client: {
        updateIssue,
        addIssueComment: vi.fn(async () => ({ id: "cmt-1" })),
      } as any,
      now: () => "2026-11-12T08:30:00Z",
    };

    const claimed = await runClaimOp(deps, {
      linearId: IDENTIFIER,
      fmTaskId: "fm-105",
      worktree: join(tempRoot, "wt"),
      harness: "codex",
      host: "station-x",
      surface: "herdr",
      branch: "feat/wake-bridge",
    });
    expect(claimed.entry.worktree).toBe(join(tempRoot, "wt"));
    expect(claimed.entry.harness).toBe("codex");
    expect(
      paperclipMutations(loadLedger({ ledgerPath }), linearIssue("In Progress", "started"), boardIssue("in_progress")),
    ).toEqual([]);

    const reported = await runReportPrOp(deps, {
      linearId: IDENTIFIER,
      prUrl: PR_URL,
      ciState: "SUCCESS",
    });
    expect(reported.entry.worktree).toBe(join(tempRoot, "wt"));
    expect(reported.entry.harness).toBe("codex");
    expect(
      paperclipMutations(loadLedger({ ledgerPath }), linearIssue("In Review", "started"), boardIssue("in_review")),
    ).toEqual([]);
  });

  it("keeps claim worktree and harness when sync applies a real Paperclip update", async () => {
    const instanceMapPath = join(tempRoot, "paperclip-instance.json");
    writeFileSync(
      instanceMapPath,
      JSON.stringify({
        schemaVersion: "paperclip-instance.v1",
        updatedAt: "2026-11-12T08:00:00Z",
        organizations: {
          "cyb-01-fleet-harness": {
            companyId: "comp-01",
            projectsBySlug: { firstmate: "pcp-proj-fm" },
          },
        },
      }),
    );
    saveLedgerAtomic(
      upsertLedgerEntry(createEmptyLedger("2026-11-12T08:00:00Z"), {
        linearIdentifier: IDENTIFIER,
        linearIssueUuid: "lin-105",
        orgSlug: "cyb-01-fleet-harness",
        paperclipCompanyId: "comp-01",
        paperclipProjectId: "pcp-proj-fm",
        paperclipIssueId: "pcp-iss-105",
        worktree: join(tempRoot, "wt"),
        harness: "codex",
        host: "station-x",
        surface: "herdr",
        branch: "feat/wake-bridge",
        lastPaperclipStatus: "todo",
        contentHash: "stale-hash",
        updatedAt: "2026-11-12T08:00:00Z",
      }),
      { ledgerPath },
    );

    const updateIssue = vi.fn(async (id: string, patch: { status?: PaperclipIssue["status"] }) => ({
      ...boardIssue("todo"),
      id,
      status: patch.status ?? "todo",
    }));
    await runSyncOp(
      {
        configPath: CONFIG_PATH,
        ledgerPath,
        instanceMapPath,
        fmHome: tempRoot,
        client: {
          listIssues: vi.fn(async () => [boardIssue("todo")]),
          updateIssue,
          createIssue: vi.fn(),
        } as any,
        fetchLinearIssues: vi.fn(async () => [linearIssue("Todo", "unstarted")]),
        fetchGitHubPrs: vi.fn(async () => []),
        loadFirstMateTasks: vi.fn(() => []),
        loadCustodySnapshot: vi.fn(async () => custody),
        now: () => "2026-11-12T09:00:00Z",
      },
      { apply: true },
    );

    expect(updateIssue).toHaveBeenCalledOnce();
    const entry = loadLedger({ ledgerPath }).entries[IDENTIFIER];
    expect(entry?.contentHash).not.toBe("stale-hash");
    expect(entry?.worktree).toBe(join(tempRoot, "wt"));
    expect(entry?.harness).toBe("codex");
    expect(entry?.host).toBe("station-x");
    expect(entry?.surface).toBe("herdr");
    expect(entry?.branch).toBe("feat/wake-bridge");
  });
});
