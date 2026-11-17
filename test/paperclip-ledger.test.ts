import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  computeIssueContentHash,
  createEmptyLedger,
  loadLedger,
  removeLedgerEntry,
  resolveLedgerPath,
  saveLedgerAtomic,
  updateLedgerCursor,
  upsertLedgerEntry,
} from "../src/paperclip/ledger.js";

describe("paperclip atomic sync ledger", () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "paperclip-ledger-test-"));
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it("resolves default ledger path under FM_HOME/state/paperclip-sync/ledger.json", () => {
    const p = resolveLedgerPath({ fmHome: "/tmp/fm-custom", env: {} });
    expect(p).toBe("/tmp/fm-custom/state/paperclip-sync/ledger.json");
    const explicit = resolveLedgerPath({
      env: { PAPERCLIP_SYNC_LEDGER: "/tmp/override/ledger.json" },
    });
    expect(explicit).toBe("/tmp/override/ledger.json");
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
});
