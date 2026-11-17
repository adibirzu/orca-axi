import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import type {
  FirstMateTaskSnapshot,
  PaperclipInstanceMap,
  PaperclipOrgInstanceEntry,
} from "./types.js";

const ISSUE_ID_RE = /\b((?:CYB|OCD)-\d+)\b/gi;

export function extractIssueIdentifiers(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(ISSUE_ID_RE)) {
    if (match[1]) found.add(match[1].toUpperCase());
  }
  return Array.from(found).sort();
}

function extractProjectsRecord(rec: Record<string, unknown>): Record<string, string> {
  const projRaw = rec.projectsBySlug ?? rec.projects;
  const out: Record<string, string> = {};
  if (projRaw && typeof projRaw === "object" && !Array.isArray(projRaw)) {
    for (const [pSlug, pVal] of Object.entries(projRaw as Record<string, unknown>)) {
      if (typeof pVal === "string" && pVal.trim()) out[pSlug] = pVal.trim();
    }
  }
  return out;
}

export function normalizeInstanceMap(raw: unknown): PaperclipInstanceMap {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { schemaVersion: "paperclip-instance.v1", organizations: {} };
  }
  const obj = raw as Record<string, unknown>;
  const orgsOut: Record<string, PaperclipOrgInstanceEntry> = {};

  const sources = [obj.orgsBySlug, obj.organizations, obj.orgs, obj.companies];
  for (const src of sources) {
    if (Array.isArray(src)) {
      for (const item of src) {
        if (!item || typeof item !== "object") continue;
        const rec = item as Record<string, unknown>;
        const slug = String(rec.slug ?? rec.key ?? "").trim();
        const companyId = String(rec.companyId ?? rec.id ?? "").trim();
        if (!slug || !companyId) continue;
        const prior = orgsOut[slug];
        orgsOut[slug] = {
          companyId,
          ...(typeof rec.code === "string" ? { code: rec.code } : {}),
          ...(typeof rec.firstmateAgentId === "string"
            ? { firstmateAgentId: rec.firstmateAgentId }
            : {}),
          projectsBySlug: { ...(prior?.projectsBySlug ?? {}), ...extractProjectsRecord(rec) },
        };
      }
    } else if (src && typeof src === "object") {
      for (const [slug, val] of Object.entries(src as Record<string, unknown>)) {
        if (typeof val === "string" && val.trim()) {
          orgsOut[slug] = { companyId: val.trim(), projectsBySlug: {} };
        } else if (val && typeof val === "object") {
          const rec = val as Record<string, unknown>;
          const companyId = String(rec.companyId ?? rec.id ?? "").trim();
          if (!companyId) continue;
          const prior = orgsOut[slug];
          orgsOut[slug] = {
            companyId,
            ...(typeof rec.code === "string" ? { code: rec.code } : {}),
            ...(typeof rec.firstmateAgentId === "string"
              ? { firstmateAgentId: rec.firstmateAgentId }
              : {}),
            projectsBySlug: { ...(prior?.projectsBySlug ?? {}), ...extractProjectsRecord(rec) },
          };
        }
      }
    }
  }

  const apiBase =
    typeof obj.apiBase === "string"
      ? obj.apiBase
      : typeof obj.primaryUrl === "string"
        ? obj.primaryUrl
        : undefined;

  return {
    schemaVersion: String(obj.schemaVersion ?? "paperclip-instance.v1"),
    ...(typeof obj.updatedAt === "string"
      ? { updatedAt: obj.updatedAt }
      : typeof obj.generatedAt === "string"
        ? { updatedAt: obj.generatedAt }
        : {}),
    ...(apiBase ? { apiBase } : {}),
    organizations: orgsOut,
  };
}

export function loadInstanceMap(instanceMapPath?: string): PaperclipInstanceMap {
  const target = resolve(
    instanceMapPath ?? join(homedir(), ".config", "orca-axi", "paperclip-instance.json"),
  );
  if (!existsSync(target)) {
    return { schemaVersion: "paperclip-instance.v1", organizations: {} };
  }
  const raw = JSON.parse(readFileSync(target, "utf8")) as unknown;
  return normalizeInstanceMap(raw);
}

export function saveInstanceMapAtomic(
  map: PaperclipInstanceMap,
  instanceMapPath?: string,
): string {
  const target = resolve(
    instanceMapPath ?? join(homedir(), ".config", "orca-axi", "paperclip-instance.json"),
  );
  mkdirSync(dirname(target), { recursive: true, mode: 0o755 });

  let payloadObj: Record<string, unknown> = { ...map };
  if (existsSync(target)) {
    try {
      const existing = JSON.parse(readFileSync(target, "utf8")) as unknown;
      if (existing && typeof existing === "object" && !Array.isArray(existing)) {
        const base = existing as Record<string, unknown>;
        if (Array.isArray(base.organizations)) {
          const mergedArr = (base.organizations as Array<Record<string, unknown>>).map((item) => {
            const slug = String(item.slug ?? "");
            const update = map.organizations[slug];
            return update
              ? { ...item, companyId: update.companyId, projectsBySlug: update.projectsBySlug }
              : item;
          });
          const bySlug =
            base.orgsBySlug && typeof base.orgsBySlug === "object"
              ? { ...(base.orgsBySlug as Record<string, Record<string, unknown>>) }
              : {};
          for (const [slug, entry] of Object.entries(map.organizations)) {
            bySlug[slug] = { ...(bySlug[slug] ?? {}), ...entry };
          }
          payloadObj = {
            ...base,
            updatedAt: map.updatedAt ?? new Date().toISOString(),
            organizations: mergedArr,
            orgsBySlug: bySlug,
          };
        }
      }
    } catch {
      // Replace cleanly if unreadable
    }
  }

  const tmpPath = `${target}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  const data = Buffer.from(`${JSON.stringify(payloadObj, null, 2)}\n`, "utf8");
  const fd = openSync(tmpPath, "w", 0o600);
  writeSync(fd, data, 0, data.length, 0);
  fsyncSync(fd);
  closeSync(fd);
  chmodSync(tmpPath, 0o600);
  renameSync(tmpPath, target);
  return target;
}

export function parseFirstMateBacklog(markdown: string): FirstMateTaskSnapshot[] {
  const results: FirstMateTaskSnapshot[] = [];
  let section: "none" | "in_flight" | "queued" = "none";
  let current: {
    taskId: string;
    title: string;
    repo?: string;
    status: "in_flight" | "queued" | "held";
    bodyLines: string[];
  } | null = null;

  const flush = (): void => {
    if (!current) return;
    const combined = `${current.title}\n${current.bodyLines.join("\n")}`;
    results.push({
      taskId: current.taskId,
      title: current.title,
      ...(current.repo ? { repo: current.repo } : {}),
      status: current.status,
      linearIdentifiers: extractIssueIdentifiers(combined),
    });
    current = null;
  };

  for (const line of markdown.split(/\r?\n/)) {
    if (line.startsWith("## ")) {
      flush();
      const heading = line.slice(3).trim().toLowerCase();
      section = heading === "in flight" ? "in_flight" : heading === "queued" ? "queued" : "none";
      continue;
    }
    if (section === "none") continue;
    const itemMatch = /^- \[ \] ([A-Za-z0-9._-]+) - (.+)$/.exec(line);
    if (itemMatch) {
      flush();
      const rest = itemMatch[2]!;
      const repoMatch = /\(repo:\s*([^)]+)\)/.exec(rest);
      current = {
        taskId: itemMatch[1]!,
        title: rest,
        ...(repoMatch?.[1] ? { repo: repoMatch[1].trim() } : {}),
        status: section === "in_flight" ? (/\(hold:/i.test(rest) ? "held" : "in_flight") : "queued",
        bodyLines: [],
      };
    } else if (current) {
      current.bodyLines.push(line);
    }
  }
  flush();
  return results;
}

export function loadFirstMateTasks(fmHome: string): FirstMateTaskSnapshot[] {
  const backlogPath = join(resolve(fmHome), "data", "backlog.md");
  const byId = new Map<string, FirstMateTaskSnapshot>();

  if (existsSync(backlogPath)) {
    for (const item of parseFirstMateBacklog(readFileSync(backlogPath, "utf8"))) {
      byId.set(item.taskId, item);
    }
  }

  const stateDir = join(resolve(fmHome), "state");
  if (existsSync(stateDir)) {
    for (const name of readdirSync(stateDir)) {
      if (!name.endsWith(".meta")) continue;
      const raw = readFileSync(join(stateDir, name), "utf8");
      const kv: Record<string, string> = {};
      for (const line of raw.split(/\r?\n/)) {
        const eq = line.indexOf("=");
        if (eq > 0) kv[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
      }
      const taskId = kv.endpoint_task_id || name.slice(0, -5);
      const ids = extractIssueIdentifiers(raw);
      const existing = byId.get(taskId);
      if (existing) {
        byId.set(taskId, {
          ...existing,
          ...(kv.worktree ? { worktree: kv.worktree } : {}),
          ...(kv.harness ? { harness: kv.harness } : {}),
          linearIdentifiers: Array.from(new Set([...existing.linearIdentifiers, ...ids])).sort(),
        });
      } else if (ids.length > 0) {
        byId.set(taskId, {
          taskId,
          title: taskId,
          ...(kv.projects ? { repo: kv.projects } : {}),
          status: "in_flight",
          linearIdentifiers: ids,
          ...(kv.worktree ? { worktree: kv.worktree } : {}),
          ...(kv.harness ? { harness: kv.harness } : {}),
        });
      }
    }
  }
  return Array.from(byId.values());
}
