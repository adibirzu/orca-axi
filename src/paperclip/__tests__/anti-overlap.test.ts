import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runPaperclipCybCli } from "../cli.js";
import { loadLedger, saveLedgerAtomic, upsertLedgerEntry, createEmptyLedger } from "../ledger.js";
import type { PaperclipCliDeps } from "../ops-workflow.js";
import { guardDispatch, loadPaperclipOrgsConfig } from "../policy.js";

const CONFIG_PATH = fileURLToPath(new URL("../../../config/paperclip-orgs.json", import.meta.url));

describe("anti-overlap guardDispatch and multi-host claiming", () => {
  let tempRoot: string;
  let ledgerPath: string;
  let instanceMapPath: string;
  let boardEnvPath: string;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "paperclip-anti-overlap-"));
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

  it("blocks duplicate claims via sync ledger, open PRs, and live Paperclip in_progress state", () => {
    const config = loadPaperclipOrgsConfig({ configPath: CONFIG_PATH });
    const ledger = upsertLedgerEntry(
      createEmptyLedger("2026-11-15T10:00:00Z"),
      {
        linearIdentifier: "CYB-510",
        linearIssueUuid: "lin-uuid-510",
        orgSlug: "cyb-01-fleet-harness",
        paperclipCompanyId: "comp-01",
        paperclipProjectId: "proj-01",
        paperclipIssueId: "pcp-iss-510",
        fmTaskId: "fm-adi1-task",
        worktree: "/home/adi/worktrees/orca-axi/cyb-510",
        harness: "codex",
        host: "adi1",
        surface: "herdr",
        lastPaperclipStatus: "in_progress",
        contentHash: "hash-1",
        updatedAt: "2026-11-15T10:00:00Z",
      },
      "2026-11-15T10:00:00Z",
    );

    const blockedByLedger = guardDispatch(config, {
      project: "orca-axi",
      host: "omarchy",
      harness: "cursor",
      issueId: "CYB-510",
      claimingTaskId: "fm-omarchy-task",
      ledger,
    });
    expect(blockedByLedger.allowed).toBe(false);
    expect(blockedByLedger.code).toBe("ISSUE_ALREADY_CLAIMED");

    const sameTaskAllowed = guardDispatch(config, {
      project: "orca-axi",
      host: "adi1",
      harness: "codex",
      issueId: "CYB-510",
      claimingTaskId: "fm-adi1-task",
      ledger,
    });
    expect(sameTaskAllowed.allowed).toBe(true);

    const blockedByPr = guardDispatch(config, {
      project: "orca-axi",
      host: "adi0",
      harness: "claude",
      issueId: "CYB-511",
      openPrs: [
        {
          repo: "adibirzu/orca-axi",
          number: 99,
          title: "[CYB-511] Open PR",
          url: "https://github.com/adibirzu/orca-axi/pull/99",
          state: "OPEN",
          headRefName: "feat/cyb-511-other",
          ciState: "PENDING",
          linearIdentifiers: ["CYB-511"],
        },
      ],
    });
    expect(blockedByPr.allowed).toBe(false);
    expect(blockedByPr.code).toBe("ISSUE_ALREADY_CLAIMED");

    const blockedByLiveStatus = guardDispatch(config, {
      project: "orca-axi",
      host: "adi0",
      harness: "claude",
      issueId: "CYB-512",
      liveIssueStatus: "in_progress",
    });
    expect(blockedByLiveStatus.allowed).toBe(false);
    expect(blockedByLiveStatus.code).toBe("ISSUE_ALREADY_CLAIMED");
  });

  it("claim persists host/surface/branch, syncs Linear In Progress, and blocks second host claim without --force", async () => {
    const comments: string[] = [];
    const linearUpdates: Array<{ uuid: string; state: string; team: string }> = [];

    const client = {
      health: vi.fn(async () => ({ status: "ok" as const })),
      listCompanies: vi.fn(async () => []),
      createCompany: vi.fn(),
      updateCompany: vi.fn(),
      listProjects: vi.fn(async () => []),
      createProject: vi.fn(),
      updateProject: vi.fn(),
      listIssues: vi.fn(async () => []),
      createIssue: vi.fn(),
      updateIssue: vi.fn(async (id: string, patch: { status?: string }) => ({
        id,
        companyId: "comp-01",
        title: "[CYB-520] Claim test",
        status: patch.status ?? "in_progress",
        priority: "high" as const,
      })),
      addIssueComment: vi.fn(async (_id: string, body: string) => {
        comments.push(body);
        return { id: "cmt-1" };
      }),
      listActivity: vi.fn(async () => []),
    };

    const seedLedger = upsertLedgerEntry(
      createEmptyLedger("2026-11-15T10:00:00Z"),
      {
        linearIdentifier: "CYB-520",
        linearIssueUuid: "lin-uuid-520",
        orgSlug: "cyb-01-fleet-harness",
        paperclipCompanyId: "comp-01",
        paperclipProjectId: "proj-01",
        paperclipIssueId: "pcp-iss-520",
        lastPaperclipStatus: "todo",
        contentHash: "seed-hash",
        updatedAt: "2026-11-15T10:00:00Z",
      },
      "2026-11-15T10:00:00Z",
    );
    saveLedgerAtomic(seedLedger, { ledgerPath, fmHome: tempRoot });

    const stdout: string[] = [];
    const deps: PaperclipCliDeps = {
      configPath: CONFIG_PATH,
      ledgerPath,
      instanceMapPath,
      boardEnvPath,
      fmHome: tempRoot,
      client: client as any,
      updateLinearIssueState: vi.fn(async (uuid, state, team) => {
        linearUpdates.push({ uuid, state, team });
      }),
      loadCustodySnapshot: vi.fn(async () => ({
        reviewforgeHost: "adrians-macbook-pro",
        fencedIssues: [],
        adi0CompanionIssues: [],
        activeBranches: [],
      })),
      writeStdout: (s) => stdout.push(s),
      now: () => "2026-11-15T10:05:00Z",
    };

    const rc1 = await runPaperclipCybCli(
      [
        "claim",
        "CYB-520",
        "--fm-task",
        "fm-adi1-cyb-520",
        "--worktree",
        "/home/adi/projects/orca-axi-cyb-520",
        "--harness",
        "codex",
        "--host",
        "adi1",
        "--surface",
        "herdr",
        "--branch",
        "feat/cyb-520",
        "--json",
      ],
      deps,
    );
    expect(rc1).toBe(0);
    expect(comments[0]).toContain("adi1");
    expect(comments[0]).toContain("herdr");
    expect(linearUpdates).toEqual([
      { uuid: "lin-uuid-520", state: "In Progress", team: "CYB" },
    ]);

    const saved = loadLedger({ ledgerPath, fmHome: tempRoot }).entries["CYB-520"];
    expect(saved?.host).toBe("adi1");
    expect(saved?.surface).toBe("herdr");
    expect(saved?.branch).toBe("feat/cyb-520");

    stdout.length = 0;
    const guardConflict = await runPaperclipCybCli(
      [
        "guard-dispatch",
        "--project",
        "orca-axi",
        "--host",
        "adi2",
        "--harness",
        "claude",
        "--issue",
        "CYB-520",
        "--json",
      ],
      deps,
    );
    expect(guardConflict).toBe(2);
    expect(JSON.parse(stdout.join("")).data.code).toBe("ISSUE_ALREADY_CLAIMED");

    stdout.length = 0;
    const duplicateClaim = await runPaperclipCybCli(
      [
        "claim",
        "CYB-520",
        "--fm-task",
        "fm-adi2-other",
        "--worktree",
        "/home/adi/projects/other",
        "--host",
        "adi2",
        "--json",
      ],
      deps,
    );
    expect(duplicateClaim).toBe(1);
    expect(JSON.parse(stdout.join("")).error).toContain("ISSUE_ALREADY_CLAIMED");
  });
});
