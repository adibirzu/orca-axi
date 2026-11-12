import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

import {
  type SyncLedger,
  type SyncLedgerEntry,
  SyncLedgerEntrySchema,
  SyncLedgerSchema,
} from "./types.js";

export interface LedgerPathOptions {
  readonly ledgerPath?: string;
  readonly fmHome?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface ContentHashInput {
  readonly linearIdentifier: string;
  readonly title: string;
  readonly targetStatus: string;
  readonly priority: string;
  readonly githubPrUrl: string | null;
  readonly ciState: string | null;
  readonly fmTaskId: string | null;
  readonly fencedBy: string | null;
}

const DEFAULT_FM_HOME = "/Users/adrianb/dev/firstmate";

export function resolveLedgerPath(options: LedgerPathOptions = {}): string {
  if (options.ledgerPath) {
    return resolve(options.ledgerPath);
  }
  const env = options.env ?? process.env;
  const explicit = env.PAPERCLIP_SYNC_LEDGER?.trim();
  if (explicit) {
    return resolve(explicit);
  }
  const fmHome = options.fmHome?.trim() || env.FM_HOME?.trim() || DEFAULT_FM_HOME;
  return join(resolve(fmHome), "state", "paperclip-sync", "ledger.json");
}

export function computeIssueContentHash(input: ContentHashInput): string {
  const canonical = JSON.stringify({
    linearIdentifier: input.linearIdentifier,
    title: input.title,
    targetStatus: input.targetStatus,
    priority: input.priority,
    githubPrUrl: input.githubPrUrl ?? null,
    ciState: input.ciState ?? null,
    fmTaskId: input.fmTaskId ?? null,
    fencedBy: input.fencedBy ?? null,
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export function createEmptyLedger(now: string = new Date().toISOString()): SyncLedger {
  return {
    schemaVersion: "paperclip-sync-ledger.v1",
    updatedAt: now,
    entries: {},
  };
}

export function loadLedger(options: LedgerPathOptions = {}): SyncLedger {
  const path = resolveLedgerPath(options);
  let rawText: string;
  try {
    rawText = readFileSync(path, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") {
      return createEmptyLedger();
    }
    throw err;
  }
  const parsed = JSON.parse(rawText) as unknown;
  return SyncLedgerSchema.parse(parsed);
}

export function saveLedgerAtomic(
  ledger: SyncLedger,
  options: LedgerPathOptions = {},
): string {
  const validated = SyncLedgerSchema.parse(ledger);
  const targetPath = resolveLedgerPath(options);
  const parentDir = dirname(targetPath);
  mkdirSync(parentDir, { recursive: true, mode: 0o700 });

  const nonce = randomBytes(6).toString("hex");
  const tmpPath = `${targetPath}.${process.pid}.${nonce}.tmp`;
  const payload = Buffer.from(`${JSON.stringify(validated, null, 2)}\n`, "utf8");

  let fd: number | null = null;
  try {
    fd = openSync(tmpPath, "w", 0o600);
    writeSync(fd, payload, 0, payload.length, 0);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    chmodSync(tmpPath, 0o600);
    renameSync(tmpPath, targetPath);
    chmodSync(targetPath, 0o600);
    return targetPath;
  } catch (err) {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // Ignore secondary close error
      }
    }
    try {
      unlinkSync(tmpPath);
    } catch {
      // Ignore missing temp cleanup
    }
    throw err;
  }
}

export function upsertLedgerEntry(
  ledger: SyncLedger,
  entry: SyncLedgerEntry,
  now: string = entry.updatedAt,
): SyncLedger {
  const validatedEntry = SyncLedgerEntrySchema.parse(entry);
  return {
    schemaVersion: "paperclip-sync-ledger.v1",
    updatedAt: now,
    ...(ledger.activityCursor ? { activityCursor: ledger.activityCursor } : {}),
    entries: {
      ...ledger.entries,
      [validatedEntry.linearIdentifier]: validatedEntry,
    },
  };
}

export function updateLedgerCursor(
  ledger: SyncLedger,
  cursor: string,
  now: string = new Date().toISOString(),
): SyncLedger {
  return {
    schemaVersion: "paperclip-sync-ledger.v1",
    updatedAt: now,
    activityCursor: cursor,
    entries: { ...ledger.entries },
  };
}

export function removeLedgerEntry(
  ledger: SyncLedger,
  linearIdentifier: string,
  now: string = new Date().toISOString(),
): SyncLedger {
  const nextEntries = Object.fromEntries(
    Object.entries(ledger.entries).filter(([key]) => key !== linearIdentifier),
  );
  return {
    schemaVersion: "paperclip-sync-ledger.v1",
    updatedAt: now,
    ...(ledger.activityCursor ? { activityCursor: ledger.activityCursor } : {}),
    entries: nextEntries,
  };
}
