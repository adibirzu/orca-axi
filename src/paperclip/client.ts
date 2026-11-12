import { z } from "zod";

import {
  DEFAULT_PRIMARY_API_BASE,
  DEFAULT_STANDBY_API_BASE,
  normalizeBaseUrl,
} from "./env.js";
import {
  type PaperclipActivity,
  PaperclipActivitySchema,
  type PaperclipCompany,
  PaperclipCompanySchema,
  type PaperclipHealth,
  PaperclipHealthSchema,
  type PaperclipIssue,
  type PaperclipIssuePriority,
  PaperclipIssueSchema,
  type PaperclipIssueStatus,
  type PaperclipProject,
  PaperclipProjectSchema,
} from "./types.js";

export {
  type BoardAuthConfig,
  DEFAULT_PRIMARY_API_BASE,
  DEFAULT_STANDBY_API_BASE,
  loadBoardAuthConfig,
  type LoadBoardAuthOptions,
  parseBoardEnv,
  runPaperclipCli,
  type RunPaperclipCliOptions,
} from "./env.js";

export interface PaperclipClientOptions {
  readonly primaryBase?: string;
  readonly standbyBase?: string;
  readonly bearerToken?: string;
  readonly cookieHeader?: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

export class PaperclipApiError extends Error {
  public readonly status: number;
  public readonly url: string;
  public readonly responseBody: string;

  constructor(message: string, status: number, url: string, responseBody: string) {
    super(message);
    this.name = "PaperclipApiError";
    this.status = status;
    this.url = url;
    this.responseBody = responseBody;
  }
}

function isFailoverStatus(status: number): boolean {
  return status === 502 || status === 503 || status === 504;
}

export class PaperclipClient {
  private readonly primaryBase: string;
  private readonly standbyBase: string;
  private readonly bearerToken?: string;
  private readonly cookieHeader?: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: PaperclipClientOptions = {}) {
    this.primaryBase = normalizeBaseUrl(options.primaryBase ?? DEFAULT_PRIMARY_API_BASE);
    this.standbyBase = normalizeBaseUrl(options.standbyBase ?? DEFAULT_STANDBY_API_BASE);
    this.bearerToken = options.bearerToken;
    this.cookieHeader = options.cookieHeader;
    this.timeoutMs = options.timeoutMs ?? 12_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private buildHeaders(extra?: Readonly<Record<string, string>>): Record<string, string> {
    return {
      Accept: "application/json",
      ...(this.bearerToken ? { Authorization: `Bearer ${this.bearerToken}` } : {}),
      ...(this.cookieHeader ? { Cookie: this.cookieHeader } : {}),
      ...(extra ?? {}),
    };
  }

  private async request<T>(
    path: string,
    schema: z.ZodType<T>,
    init: {
      readonly method?: string;
      readonly body?: unknown;
      readonly headers?: Readonly<Record<string, string>>;
    } = {},
  ): Promise<T> {
    const bases =
      this.standbyBase && this.standbyBase !== this.primaryBase
        ? [this.primaryBase, this.standbyBase]
        : [this.primaryBase];

    const method = init.method ?? "GET";
    const hasBody = init.body !== undefined;
    const headers = this.buildHeaders({
      ...(hasBody ? { "Content-Type": "application/json" } : {}),
      ...(init.headers ?? {}),
    });
    const serializedBody = hasBody ? JSON.stringify(init.body) : undefined;

    let lastError: unknown;
    for (let idx = 0; idx < bases.length; idx += 1) {
      const url = `${bases[idx]}${path}`;
      const canFailover = idx < bases.length - 1;
      try {
        const res = await this.fetchImpl(url, {
          method,
          headers,
          body: serializedBody,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        const text = await res.text();
        if (!res.ok) {
          if (canFailover && isFailoverStatus(res.status)) {
            lastError = new PaperclipApiError(`HTTP ${res.status} from ${url}`, res.status, url, text);
            continue;
          }
          throw new PaperclipApiError(
            `Paperclip API ${method} ${path} failed with HTTP ${res.status}`,
            res.status,
            url,
            text,
          );
        }
        return schema.parse(text ? (JSON.parse(text) as unknown) : {});
      } catch (err) {
        if (err instanceof PaperclipApiError) throw err;
        lastError = err;
        if (!canFailover) throw err;
      }
    }
    throw lastError instanceof Error ? lastError : new Error("Paperclip request failed");
  }

  async health(): Promise<PaperclipHealth> {
    return this.request("/api/health", PaperclipHealthSchema);
  }

  async listCompanies(): Promise<PaperclipCompany[]> {
    return this.request("/api/companies", z.array(PaperclipCompanySchema));
  }

  async createCompany(input: {
    readonly name: string;
    readonly description?: string;
    readonly budgetMonthlyCents?: number;
  }): Promise<PaperclipCompany> {
    return this.request("/api/companies", PaperclipCompanySchema, {
      method: "POST",
      body: {
        name: input.name,
        ...(input.description !== undefined ? { description: input.description } : {}),
        budgetMonthlyCents: input.budgetMonthlyCents ?? 0,
      },
    });
  }

  async updateCompany(
    companyId: string,
    patch: { readonly name?: string; readonly description?: string; readonly budgetMonthlyCents?: number },
  ): Promise<PaperclipCompany> {
    return this.request(`/api/companies/${encodeURIComponent(companyId)}`, PaperclipCompanySchema, {
      method: "PATCH",
      body: patch,
    });
  }

  async listProjects(companyId: string): Promise<PaperclipProject[]> {
    return this.request(
      `/api/companies/${encodeURIComponent(companyId)}/projects`,
      z.array(PaperclipProjectSchema),
    );
  }

  async createProject(
    companyId: string,
    input: { readonly name: string; readonly description?: string; readonly repoUrl?: string | null },
  ): Promise<PaperclipProject> {
    return this.request(`/api/companies/${encodeURIComponent(companyId)}/projects`, PaperclipProjectSchema, {
      method: "POST",
      body: {
        name: input.name,
        ...(input.description ? { description: input.description } : {}),
        status: "in_progress",
        ...(input.repoUrl
          ? { workspace: { name: input.name, repoUrl: input.repoUrl, isPrimary: true } }
          : {}),
      },
    });
  }

  async updateProject(
    projectId: string,
    patch: { readonly name?: string; readonly description?: string },
  ): Promise<PaperclipProject> {
    return this.request(`/api/projects/${encodeURIComponent(projectId)}`, PaperclipProjectSchema, {
      method: "PATCH",
      body: patch,
    });
  }

  async listIssues(
    companyId: string,
    filters?: { readonly status?: readonly PaperclipIssueStatus[]; readonly projectId?: string },
  ): Promise<PaperclipIssue[]> {
    const params = new URLSearchParams();
    if (filters?.status?.length) params.set("status", filters.status.join(","));
    if (filters?.projectId) params.set("projectId", filters.projectId);
    const qs = params.toString();
    return this.request(
      `/api/companies/${encodeURIComponent(companyId)}/issues${qs ? `?${qs}` : ""}`,
      z.array(PaperclipIssueSchema),
    );
  }

  async getIssue(issueId: string): Promise<PaperclipIssue> {
    return this.request(`/api/issues/${encodeURIComponent(issueId)}`, PaperclipIssueSchema);
  }

  async createIssue(
    companyId: string,
    input: {
      readonly title: string;
      readonly description?: string;
      readonly status?: PaperclipIssueStatus;
      readonly priority?: PaperclipIssuePriority;
      readonly projectId?: string;
      readonly assigneeAgentId?: string;
    },
  ): Promise<PaperclipIssue> {
    return this.request(`/api/companies/${encodeURIComponent(companyId)}/issues`, PaperclipIssueSchema, {
      method: "POST",
      body: input,
    });
  }

  async updateIssue(
    issueId: string,
    patch: {
      readonly title?: string;
      readonly description?: string;
      readonly status?: PaperclipIssueStatus;
      readonly priority?: PaperclipIssuePriority;
      readonly projectId?: string;
      readonly assigneeAgentId?: string;
      readonly comment?: string;
    },
    runId?: string,
  ): Promise<PaperclipIssue> {
    return this.request(`/api/issues/${encodeURIComponent(issueId)}`, PaperclipIssueSchema, {
      method: "PATCH",
      body: patch,
      headers: runId ? { "X-Paperclip-Run-Id": runId } : undefined,
    });
  }

  async addIssueComment(issueId: string, body: string): Promise<{ readonly id?: string }> {
    return this.request(
      `/api/issues/${encodeURIComponent(issueId)}/comments`,
      z.object({ id: z.string().optional() }),
      { method: "POST", body: { body } },
    );
  }

  async listActivity(
    companyId: string,
    filters?: { readonly entityType?: string; readonly entityId?: string },
  ): Promise<PaperclipActivity[]> {
    const params = new URLSearchParams();
    if (filters?.entityType) params.set("entityType", filters.entityType);
    if (filters?.entityId) params.set("entityId", filters.entityId);
    const qs = params.toString();
    return this.request(
      `/api/companies/${encodeURIComponent(companyId)}/activity${qs ? `?${qs}` : ""}`,
      z.array(PaperclipActivitySchema),
    );
  }

  async requestJson<T>(
    path: string,
    schema: z.ZodType<T>,
    init: {
      readonly method?: string;
      readonly body?: unknown;
      readonly headers?: Readonly<Record<string, string>>;
    } = {},
  ): Promise<T> {
    return this.request(path, schema, init);
  }
}
