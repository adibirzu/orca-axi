import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { parseBoardEnv } from "./env.js";
import {
  buildProjectLookup,
  deduplicateIssues,
  defaultExecCommand,
  type ExecCommandFn,
  mapCliOrCacheItem,
  mapGraphqlNode,
  type ProjectLookup,
  runWithConcurrency,
} from "./linear-mapper.js";
import type { LinearIssueSnapshot, PaperclipOrgsConfig } from "./types.js";

export { defaultExecCommand, type ExecCommandFn, runWithConcurrency };

const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";

export interface LinearFetchOptions {
  readonly apiKey?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly boardEnvPath?: string;
  readonly cachePath?: string;
  readonly fetchImpl?: typeof fetch;
  readonly execFn?: ExecCommandFn;
}

function resolveLinearApiKey(config: PaperclipOrgsConfig, options: LinearFetchOptions): string {
  if (options.apiKey !== undefined) return options.apiKey.trim();
  const env = options.env ?? process.env;
  const fromEnv = (env.LINEAR_API_KEY ?? "").trim();
  if (fromEnv) return fromEnv;

  const boardEnvPath = options.boardEnvPath ?? config.controlPlane.boardEnvPath;
  if (!existsSync(boardEnvPath)) return "";
  try {
    return (parseBoardEnv(readFileSync(boardEnvPath, "utf8")).LINEAR_API_KEY ?? "").trim();
  } catch {
    return "";
  }
}

async function fetchGraphqlPages(
  fetchFn: typeof fetch,
  apiKey: string,
  query: string,
  baseVars: Readonly<Record<string, string>>,
  extractConnection: (data: Record<string, unknown>) => Record<string, unknown> | undefined,
  lookup: ProjectLookup,
): Promise<LinearIssueSnapshot[]> {
  const collected: LinearIssueSnapshot[] = [];
  let after: string | null = null;

  for (let page = 0; page < 20; page += 1) {
    const res = await fetchFn(LINEAR_GRAPHQL_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: apiKey },
      body: JSON.stringify({
        query,
        variables: after ? { ...baseVars, after } : { ...baseVars },
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`Linear GraphQL HTTP ${res.status}`);

    const body = (await res.json()) as Record<string, unknown>;
    const conn = extractConnection((body.data ?? {}) as Record<string, unknown>) ?? {};
    const nodes = (Array.isArray(conn.nodes) ? conn.nodes : []) as Array<Record<string, unknown>>;
    for (const node of nodes) {
      const mapped = mapGraphqlNode(node, lookup);
      if (mapped) collected.push(mapped);
    }

    const pageInfo = conn.pageInfo as Record<string, unknown> | undefined;
    const nextCursor = typeof pageInfo?.endCursor === "string" ? pageInfo.endCursor : null;
    if (!pageInfo?.hasNextPage || !nextCursor) break;
    after = nextCursor;
  }
  return collected;
}

async function fetchTier1Graphql(
  config: PaperclipOrgsConfig,
  apiKey: string,
  fetchFn: typeof fetch,
  lookup: ProjectLookup,
): Promise<LinearIssueSnapshot[]> {
  const issueFields = `
    pageInfo { hasNextPage endCursor }
    nodes {
      id identifier title description url priority branchName
      state { name type }
      project { id name }
      inverseRelations { nodes { type issue { identifier state { type } } } }
    }
  `;
  const teamQuery = `query TeamIssuesPage($teamId: ID!, $after: String) {
    issues(first: 250, after: $after, filter: { team: { id: { eq: $teamId } } }) { ${issueFields} }
  }`;
  const projectQuery = `query ProjectIssuesPage($projectId: String!, $after: String) {
    project(id: $projectId) { issues(first: 250, after: $after) { ${issueFields} } }
  }`;

  const teamItems = await fetchGraphqlPages(
    fetchFn,
    apiKey,
    teamQuery,
    { teamId: config.controlPlane.linearTeam.uuid },
    (data) => data.issues as Record<string, unknown> | undefined,
    lookup,
  );
  const crossLists = await Promise.all(
    lookup.crossTeamProjects.map((proj) =>
      fetchGraphqlPages(
        fetchFn,
        apiKey,
        projectQuery,
        { projectId: proj.uuid },
        (data) =>
          (data.project as Record<string, unknown> | undefined)?.issues as
            | Record<string, unknown>
            | undefined,
        lookup,
      ),
    ),
  );
  return deduplicateIssues([...teamItems, ...crossLists.flat()]);
}

async function fetchTier2OrcaCli(
  lookup: ProjectLookup,
  execFn: ExecCommandFn,
): Promise<LinearIssueSnapshot[] | null> {
  const queries: ReadonlyArray<readonly string[]> = [
    ["linear", "list-issues", "--team", "CYB", "--json"],
    ...lookup.crossTeamProjects.map((p) => ["linear", "list-issues", "--project", p.id, "--json"]),
  ];
  const collected: LinearIssueSnapshot[] = [];
  let anyOk = false;

  for (const args of queries) {
    try {
      const stdout = await execFn("orca", args);
      const parsed = JSON.parse(stdout || "{}") as Record<string, unknown>;
      if (parsed.ok === false) continue;
      anyOk = true;
      const resultWrap = parsed.result as Record<string, unknown> | undefined;
      const rawList = Array.isArray(parsed)
        ? parsed
        : (parsed.issues ?? parsed.items ?? resultWrap?.issues ?? resultWrap?.items ?? []);
      if (!Array.isArray(rawList)) continue;
      for (const item of rawList as Array<Record<string, unknown>>) {
        const mapped = mapCliOrCacheItem(item, lookup);
        if (mapped) collected.push(mapped);
      }
    } catch {
      // Fall through to cache when orca CLI is unavailable or locked
    }
  }

  const deduped = deduplicateIssues(collected);
  return anyOk && deduped.length > 0 ? deduped : null;
}

function fetchTier3Cache(
  lookup: ProjectLookup,
  options: LinearFetchOptions,
): LinearIssueSnapshot[] {
  const env = options.env ?? process.env;
  const cachePath =
    (options.cachePath ?? (env.LINEAR_ISSUES_CACHE_PATH ?? "").trim()) ||
    join(homedir(), ".config", "orca-axi", "linear-issues-cache.json");

  if (!existsSync(cachePath)) return [];
  try {
    const parsed = JSON.parse(readFileSync(cachePath, "utf8")) as unknown;
    const rawList = Array.isArray(parsed)
      ? parsed
      : Array.isArray((parsed as Record<string, unknown>)?.issues)
        ? ((parsed as Record<string, unknown>).issues as unknown[])
        : [];
    const mapped = rawList
      .map((item) => mapCliOrCacheItem((item ?? {}) as Record<string, unknown>, lookup))
      .filter((item): item is LinearIssueSnapshot => item !== null);
    return deduplicateIssues(mapped);
  } catch {
    return [];
  }
}

export async function fetchLinearIssuesLive(
  config: PaperclipOrgsConfig,
  options: LinearFetchOptions = {},
): Promise<LinearIssueSnapshot[]> {
  const lookup = buildProjectLookup(config);
  const apiKey = resolveLinearApiKey(config, options);
  if (apiKey) return fetchTier1Graphql(config, apiKey, options.fetchImpl ?? fetch, lookup);

  const viaOrca = await fetchTier2OrcaCli(lookup, options.execFn ?? defaultExecCommand);
  if (viaOrca) return viaOrca;

  return fetchTier3Cache(lookup, options);
}

export async function updateLinearIssueStateLive(
  issueUuidOrId: string,
  targetStateName: string,
  teamUuid: string,
  options: LinearFetchOptions = {},
): Promise<void> {
  const env = options.env ?? process.env;
  let apiKey = (options.apiKey ?? env.LINEAR_API_KEY ?? "").trim();
  if (!apiKey && options.boardEnvPath && existsSync(options.boardEnvPath)) {
    apiKey = (parseBoardEnv(readFileSync(options.boardEnvPath, "utf8")).LINEAR_API_KEY ?? "").trim();
  }

  if (!apiKey) {
    try {
      const execFn = options.execFn ?? defaultExecCommand;
      await execFn("orca", [
        "linear",
        "status",
        "set",
        issueUuidOrId,
        "--to",
        targetStateName,
        "--json",
      ]);
    } catch {
      // Headless shell without unlocked Linear keychain degrades gracefully
    }
    return;
  }

  const fetchFn = options.fetchImpl ?? fetch;
  const statesQuery = `query WorkflowStates($teamId: ID!) {
    workflowStates(filter: { team: { id: { eq: $teamId } } }) { nodes { id name type } }
  }`;
  const sRes = await fetchFn(LINEAR_GRAPHQL_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: apiKey },
    body: JSON.stringify({ query: statesQuery, variables: { teamId: teamUuid } }),
    signal: AbortSignal.timeout(15_000),
  });
  const sBody = (await sRes.json()) as Record<string, unknown>;
  const wf = ((sBody.data as Record<string, unknown> | undefined)?.workflowStates ?? {}) as Record<
    string,
    unknown
  >;
  const states = (Array.isArray(wf.nodes) ? wf.nodes : []) as Array<Record<string, string>>;
  const match = states.find(
    (s) => s.name?.trim().toLowerCase() === targetStateName.trim().toLowerCase(),
  );
  if (!match?.id) return;

  const mutation = `mutation UpdateState($id: String!, $stateId: String!) {
    issueUpdate(id: $id, input: { stateId: $stateId }) { success }
  }`;
  await fetchFn(LINEAR_GRAPHQL_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: apiKey },
    body: JSON.stringify({ query: mutation, variables: { id: issueUuidOrId, stateId: match.id } }),
    signal: AbortSignal.timeout(15_000),
  });
}
