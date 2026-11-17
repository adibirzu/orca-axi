import { execFile } from "node:child_process";

import type { LinearIssueSnapshot, PaperclipOrgsConfig } from "./types.js";

const ISSUE_ID_RE = /^(CYB|OCD)-\d+$/i;
const VALID_STATE_TYPES = new Set(["backlog", "unstarted", "started", "completed", "canceled"]);

export type ExecCommandFn = (cmd: string, args: readonly string[]) => Promise<string>;

export interface ProjectSpecEntry {
  readonly id: string;
  readonly uuid: string;
  readonly name: string;
  readonly team: "CYB" | "OCD";
}

export interface ProjectLookup {
  readonly byUuid: ReadonlyMap<string, ProjectSpecEntry>;
  readonly byName: ReadonlyMap<string, ProjectSpecEntry>;
  readonly crossTeamProjects: readonly ProjectSpecEntry[];
}

export function defaultExecCommand(cmd: string, args: readonly string[]): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      cmd,
      [...args],
      { shell: false, timeout: 20_000, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => {
        if (err) rejectPromise(err);
        else resolvePromise(String(stdout));
      },
    );
  });
}

export async function runWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const limit = Math.max(1, Math.min(Math.trunc(concurrency) || 1, items.length));
  const results = new Array<R>(items.length);
  let cursor = 0;

  const runLane = async (): Promise<void> => {
    while (cursor < items.length) {
      const idx = cursor;
      cursor += 1;
      results[idx] = await worker(items[idx]!, idx);
    }
  };

  await Promise.all(Array.from({ length: limit }, () => runLane()));
  return results;
}

export function buildProjectLookup(config: PaperclipOrgsConfig): ProjectLookup {
  const byUuid = new Map<string, ProjectSpecEntry>();
  const byName = new Map<string, ProjectSpecEntry>();
  const crossTeamProjects: ProjectSpecEntry[] = [];

  for (const org of config.organizations) {
    for (const p of org.projects) {
      const entry: ProjectSpecEntry = {
        id: p.id,
        uuid: p.linearUuid,
        name: p.name,
        team: p.linearTeam,
      };
      byUuid.set(p.linearUuid, entry);
      byName.set(p.name.trim().toLowerCase(), entry);
      byName.set(p.slug.trim().toLowerCase(), entry);
      byName.set(p.id.trim().toLowerCase(), entry);
      if (p.linearTeam !== config.controlPlane.linearTeam.key) {
        crossTeamProjects.push(entry);
      }
    }
  }
  return { byUuid, byName, crossTeamProjects };
}

function normalizeStateType(raw: unknown): LinearIssueSnapshot["stateType"] {
  const lowered = String(raw ?? "unstarted").trim().toLowerCase();
  if (lowered === "duplicate") return "canceled";
  return VALID_STATE_TYPES.has(lowered)
    ? (lowered as LinearIssueSnapshot["stateType"])
    : "unstarted";
}

function normalizePriority(raw: unknown): number {
  const num =
    typeof raw === "number"
      ? raw
      : raw && typeof raw === "object"
        ? Number((raw as Record<string, unknown>).value ?? 0)
        : Number(raw ?? 0);
  if (!Number.isFinite(num)) return 0;
  return Math.min(4, Math.max(0, Math.trunc(num)));
}

export function mapGraphqlNode(
  node: Record<string, unknown>,
  lookup: ProjectLookup,
): LinearIssueSnapshot | null {
  const proj = node.project as Record<string, unknown> | null | undefined;
  const projUuid = String(proj?.id ?? "");
  const mapped =
    lookup.byUuid.get(projUuid) ??
    lookup.byName.get(String(proj?.name ?? "").trim().toLowerCase());
  if (!mapped) return null;

  const identifier = String(node.identifier ?? "").trim().toUpperCase();
  if (!ISSUE_ID_RE.test(identifier)) return null;

  const invWrap = node.inverseRelations as Record<string, unknown> | undefined;
  const inv = (Array.isArray(invWrap?.nodes) ? invWrap.nodes : []) as Array<Record<string, unknown>>;
  const blockedBy = inv
    .filter((rel) => {
      const relIssue = rel.issue as Record<string, unknown> | undefined;
      const st = relIssue?.state as Record<string, unknown> | undefined;
      return (
        rel.type === "blocks" &&
        !["completed", "canceled"].includes(String(st?.type ?? "").toLowerCase())
      );
    })
    .map((rel) => String((rel.issue as Record<string, unknown> | undefined)?.identifier ?? ""))
    .filter(Boolean);

  const stObj = node.state as Record<string, unknown> | undefined;
  const branch = String(node.branchName ?? "").trim();
  return {
    id: String(node.id),
    identifier,
    title: String(node.title ?? identifier),
    description: String(node.description ?? ""),
    url: String(node.url ?? `https://linear.app/cyber-sec/issue/${identifier}`),
    stateType: normalizeStateType(stObj?.type),
    stateName: String(stObj?.name ?? "Todo"),
    priority: normalizePriority(node.priority),
    projectId: mapped.id,
    projectUuid: mapped.uuid,
    projectName: mapped.name,
    teamKey: mapped.team,
    blockedBy,
    ...(branch ? { branchName: branch } : {}),
  };
}

export function mapCliOrCacheItem(
  raw: Record<string, unknown>,
  lookup: ProjectLookup,
): LinearIssueSnapshot | null {
  const candidateId = String(raw.identifier ?? raw.id ?? "").trim().toUpperCase();
  if (!ISSUE_ID_RE.test(candidateId)) return null;

  const projObj = raw.project && typeof raw.project === "object"
    ? (raw.project as Record<string, unknown>)
    : undefined;
  const projUuid = String(raw.projectId ?? projObj?.id ?? "").trim();
  const projName = String(
    typeof raw.project === "string" ? raw.project : (projObj?.name ?? raw.projectName ?? ""),
  )
    .trim()
    .toLowerCase();

  const mapped = lookup.byUuid.get(projUuid) ?? lookup.byName.get(projName);
  if (!mapped) return null;

  const stObj = raw.state && typeof raw.state === "object"
    ? (raw.state as Record<string, unknown>)
    : undefined;
  const branch = String(raw.gitBranchName ?? raw.branchName ?? "").trim();
  const blockedBy = Array.isArray(raw.blockedBy)
    ? raw.blockedBy.map((b) => String(b).toUpperCase()).filter((b) => ISSUE_ID_RE.test(b))
    : [];

  return {
    id: String(raw.uuid ?? (raw.identifier ? raw.id : undefined) ?? candidateId),
    identifier: candidateId,
    title: String(raw.title ?? candidateId),
    description: String(raw.description ?? ""),
    url: String(raw.url ?? `https://linear.app/cyber-sec/issue/${candidateId}`),
    stateType: normalizeStateType(raw.statusType ?? stObj?.type),
    stateName: String(raw.status ?? stObj?.name ?? "Todo").trim() || "Todo",
    priority: normalizePriority(raw.priority),
    projectId: mapped.id,
    projectUuid: mapped.uuid,
    projectName: mapped.name,
    teamKey: mapped.team,
    blockedBy,
    ...(branch ? { branchName: branch } : {}),
  };
}

export function deduplicateIssues(items: readonly LinearIssueSnapshot[]): LinearIssueSnapshot[] {
  const seen = new Set<string>();
  const out: LinearIssueSnapshot[] = [];
  for (const item of items) {
    if (seen.has(item.identifier)) continue;
    seen.add(item.identifier);
    out.push(item);
  }
  return out;
}
