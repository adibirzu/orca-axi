import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  computeIssueContentHash,
  createEmptyLedger,
  loadLedger,
  removeLedgerEntry,
  resolveFmHome,
  resolveLedgerPath,
  saveLedgerAtomic,
  updateLedgerCursor,
  upsertLedgerEntry,
} from "../src/paperclip/ledger.js";
import { runClaimOp, runReportPrOp } from "../src/paperclip/ops-workflow.js";

const CONFIG_PATH = fileURLToPath(new URL("../config/paperclip-orgs.json", import.meta.url));

describe("paperclip atomic sync ledger", () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "paperclip-ledger-test-"));
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it("resolves ledger path with explicit binding precedence", () => {
    const byOption = resolveLedgerPath({
      ledgerPath: "/tmp/opt-ledger.json",
      fmHome: "/tmp/fm-ignored",
      env: { PAPERCLIP_SYNC_LEDGER: "/tmp/env-ledger.json", FM_HOME: "/tmp/fm-env" },
    });
    expect(byOption).toBe(resolve("/tmp/opt-ledger.json"));

    const byEnvLedger = resolveLedgerPath({
      fmHome: "/tmp/fm-ignored",
      env: { PAPERCLIP_SYNC_LEDGER: "/tmp/env-ledger.json", FM_HOME: "/tmp/fm-env" },
    });
    expect(byEnvLedger).toBe(resolve("/tmp/env-ledger.json"));

    const byOptionHome = resolveLedgerPath({
      fmHome: "/tmp/fm-custom",
      env: { FM_HOME: "/tmp/fm-env" },
    });
    expect(byOptionHome).toBe("/tmp/fm-custom/state/paperclip-sync/ledger.json");

    const byEnvHome = resolveLedgerPath({ env: { FM_HOME: "/tmp/fm-env" } });
    expect(byEnvHome).toBe("/tmp/fm-env/state/paperclip-sync/ledger.json");

    const relative = resolveLedgerPath({
      ledgerPath: "relative-ledger.json",
      env: {},
    });
    expect(relative).toBe(resolve("relative-ledger.json"));
  });

  it("maps distinct Firstmate homes to distinct ledger paths", () => {
    const homeA = join(tempRoot, "home-a");
    const homeB = join(tempRoot, "home-b");
    expect(resolveLedgerPath({ fmHome: homeA, env: {} })).toBe(
      join(resolve(homeA), "state", "paperclip-sync", "ledger.json"),
    );
    expect(resolveLedgerPath({ fmHome: homeB, env: {} })).toBe(
      join(resolve(homeB), "state", "paperclip-sync", "ledger.json"),
    );
    expect(existsSync(join(homeA, "state"))).toBe(false);
    expect(existsSync(join(homeB, "state"))).toBe(false);
  });

  it("refuses missing or whitespace-only bindings before filesystem writes", () => {
    expect(() => resolveLedgerPath({ env: {} })).toThrow(/Paperclip sync ledger binding required/);
    expect(() => resolveLedgerPath({ fmHome: "   ", env: { FM_HOME: "\t" } })).toThrow(
      /Paperclip sync ledger binding required/,
    );
    expect(() =>
      resolveLedgerPath({
        ledgerPath: "  ",
        env: { PAPERCLIP_SYNC_LEDGER: " ", FM_HOME: "" },
      }),
    ).toThrow(/Paperclip sync ledger binding required/);
    expect(() => resolveFmHome({ env: {} })).toThrow(/FirstMate home binding required/);
    expect(() => resolveFmHome({ fmHome: "  ", env: { FM_HOME: "\n" } })).toThrow(
      /FirstMate home binding required/,
    );

    expect(() => loadLedger({ env: {} })).toThrow(/Paperclip sync ledger binding required/);
    expect(() => saveLedgerAtomic(createEmptyLedger(), { env: {} })).toThrow(
      /Paperclip sync ledger binding required/,
    );
    expect(existsSync(join(tempRoot, "state"))).toBe(false);
  });

  it("loads and saves with an explicit ledger path without FM_HOME", () => {
    const ledgerPath = join(tempRoot, "standalone-ledger.json");
    const initial = loadLedger({ ledgerPath, env: {} });
    expect(initial.entries).toEqual({});
    saveLedgerAtomic(initial, { ledgerPath, env: {} });
    expect(statSync(ledgerPath).mode & 0o777).toBe(0o600);
    expect(loadLedger({ ledgerPath, env: {} }).schemaVersion).toBe("paperclip-sync-ledger.v1");
  });

  it("returns empty ledger when file does not exist and persists atomically with mode 0600", () => {
    const ledgerPath = join(tempRoot, "state", "paperclip-sync", "ledger.json");
    const initial = loadLedger({ ledgerPath });
    expect(initial.schemaVersion).toBe("paperclip-sync-ledger.v1");
    expect(initial.entries).toEqual({});

    const hash = computeIssueContentHash({
      linearIdentifier: "CYB-42",
      title: "Add reconciliation tests",
      targetStatus: "todo",
      priority: "high",
      githubPrUrl: null,
      ciState: null,
      fmTaskId: null,
      fencedBy: null,
    });

    const next = upsertLedgerEntry(
      initial,
      {
        linearIdentifier: "CYB-42",
        orgSlug: "cyb-01-fleet-harness",
        paperclipCompanyId: "comp-01",
        paperclipProjectId: "proj-73",
        paperclipIssueId: "iss-100",
        lastPaperclipStatus: "todo",
        contentHash: hash,
        updatedAt: "2026-11-12T08:00:00Z",
      },
      "2026-11-12T08:00:00Z",
    );

    // Immutability check: initial was not mutated
    expect(initial.entries["CYB-42"]).toBeUndefined();
    expect(next.entries["CYB-42"]?.paperclipIssueId).toBe("iss-100");

    saveLedgerAtomic(next, { ledgerPath });
    const st = statSync(ledgerPath);
    expect(st.mode & 0o777).toBe(0o600);

    const reloaded = loadLedger({ ledgerPath });
    expect(reloaded.entries["CYB-42"]?.contentHash).toBe(hash);

    const withCursor = updateLedgerCursor(reloaded, "2026-11-12T08:05:00Z", "2026-11-12T08:05:01Z");
    expect(reloaded.activityCursor).toBeUndefined();
    expect(withCursor.activityCursor).toBe("2026-11-12T08:05:00Z");

    const afterRemove = removeLedgerEntry(withCursor, "CYB-42", "2026-11-12T08:06:00Z");
    expect(withCursor.entries["CYB-42"]).toBeDefined();
    expect(afterRemove.entries["CYB-42"]).toBeUndefined();
  });

  it("computes deterministic content hashes and rejects malformed ledger JSON", () => {
    const h1 = computeIssueContentHash({
      linearIdentifier: "CYB-10",
      title: "Fix gateway",
      targetStatus: "in_review",
      priority: "critical",
      githubPrUrl: "https://github.com/adibirzu/orca-axi/pull/6",
      ciState: "SUCCESS",
      fmTaskId: "fm-10",
      fencedBy: null,
    });
    const h2 = computeIssueContentHash({
      linearIdentifier: "CYB-10",
      title: "Fix gateway",
      targetStatus: "in_review",
      priority: "critical",
      githubPrUrl: "https://github.com/adibirzu/orca-axi/pull/6",
      ciState: "SUCCESS",
      fmTaskId: "fm-10",
      fencedBy: null,
    });
    const h3 = computeIssueContentHash({
      linearIdentifier: "CYB-10",
      title: "Fix gateway",
      targetStatus: "done",
      priority: "critical",
      githubPrUrl: "https://github.com/adibirzu/orca-axi/pull/6",
      ciState: "SUCCESS",
      fmTaskId: "fm-10",
      fencedBy: null,
    });
    expect(h1).toBe(h2);
    expect(h1).not.toBe(h3);

    const badPath = join(tempRoot, "corrupt.json");
    writeFileSync(badPath, "{invalid-json", "utf8");
    expect(() => loadLedger({ ledgerPath: badPath })).toThrow();

    const empty = createEmptyLedger("2026-11-12T08:00:00Z");
    expect(empty.updatedAt).toBe("2026-11-12T08:00:00Z");
  });

  it("refuses claim and report-pr before API writes when ledger binding is missing", async () => {
    const updateIssue = vi.fn(async () => ({
      id: "iss-1",
      companyId: "comp-1",
      title: "[CYB-1]",
      status: "in_progress" as const,
      priority: "high" as const,
    }));
    const addIssueComment = vi.fn(async () => ({ id: "cmt-1" }));
    const deps = {
      client: { updateIssue, addIssueComment } as any,
      fmHome: "   ",
    };
    const previousFmHome = process.env.FM_HOME;
    const previousLedger = process.env.PAPERCLIP_SYNC_LEDGER;
    delete process.env.FM_HOME;
    delete process.env.PAPERCLIP_SYNC_LEDGER;
    try {
      await expect(
        runClaimOp(deps, {
          linearId: "CYB-1",
          fmTaskId: "fm-1",
          worktree: join(tempRoot, "wt"),
        }),
      ).rejects.toThrow(/Paperclip sync ledger binding required/);
      await expect(
        runReportPrOp(deps, {
          linearId: "CYB-1",
          prUrl: "https://example.invalid/pr/1",
        }),
      ).rejects.toThrow(/Paperclip sync ledger binding required/);
    } finally {
      if (previousFmHome === undefined) delete process.env.FM_HOME;
      else process.env.FM_HOME = previousFmHome;
      if (previousLedger === undefined) delete process.env.PAPERCLIP_SYNC_LEDGER;
      else process.env.PAPERCLIP_SYNC_LEDGER = previousLedger;
    }
    expect(updateIssue).not.toHaveBeenCalled();
    expect(addIssueComment).not.toHaveBeenCalled();
  });

  it("claims and reports with an explicit ledger path and no FM_HOME", async () => {
    const ledgerPath = join(tempRoot, "claim-ledger.json");
    const hash = computeIssueContentHash({
      linearIdentifier: "CYB-7",
      title: "[CYB-7]",
      targetStatus: "todo",
      priority: "high",
      githubPrUrl: null,
      ciState: null,
      fmTaskId: null,
      fencedBy: null,
    });
    saveLedgerAtomic(
      upsertLedgerEntry(createEmptyLedger("2026-11-12T08:00:00Z"), {
        linearIdentifier: "CYB-7",
        orgSlug: "cyb-01-fleet-harness",
        paperclipCompanyId: "comp-01",
        paperclipIssueId: "iss-7",
        lastPaperclipStatus: "todo",
        contentHash: hash,
        updatedAt: "2026-11-12T08:00:00Z",
      }),
      { ledgerPath, env: {} },
    );

    const comments: string[] = [];
    const updateIssue = vi.fn(async (id: string, patch: { status?: string }) => ({
      id,
      companyId: "comp-01",
      title: "[CYB-7]",
      status: patch.status ?? "todo",
      priority: "high" as const,
    }));
    const addIssueComment = vi.fn(async (_id: string, body: string) => {
      comments.push(body);
      return { id: "cmt-1" };
    });

    const deps = {
      configPath: CONFIG_PATH,
      ledgerPath,
      client: { updateIssue, addIssueComment } as any,
    };
    const previousFmHome = process.env.FM_HOME;
    delete process.env.FM_HOME;
    try {
      const claimed = await runClaimOp(deps, {
        linearId: "CYB-7",
        fmTaskId: "fm-7",
        worktree: join(tempRoot, "wt"),
        harness: "codex",
      });
      expect(claimed.entry.fmTaskId).toBe("fm-7");
      expect(comments[0]).toContain("Claimed by FirstMate task");
      expect(comments[0]).not.toMatch(/\badi0\b/);

      const reported = await runReportPrOp(deps, {
        linearId: "CYB-7",
        prUrl: "https://github.com/adibirzu/orca-axi/pull/99",
        ciState: "SUCCESS",
      });
      expect(reported.entry.githubPrUrl).toBe("https://github.com/adibirzu/orca-axi/pull/99");
      expect(updateIssue).toHaveBeenCalled();
    } finally {
      if (previousFmHome === undefined) delete process.env.FM_HOME;
      else process.env.FM_HOME = previousFmHome;
    }
  });
});
