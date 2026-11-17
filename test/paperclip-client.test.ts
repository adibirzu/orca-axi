import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  loadBoardAuthConfig,
  PaperclipApiError,
  PaperclipClient,
  parseBoardEnv,
  runPaperclipCli,
} from "../src/paperclip/client.js";

describe("paperclip REST client & safe CLI helper", () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "paperclip-client-test-"));
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it("parses cyb-board.env cleanly without shell execution and defaults to adi5 -> adihost4 failover", () => {
    const parsed = parseBoardEnv(`
      # Comment line
      export PAPERCLIP_API_BASE="https://adi5.tailb55406.ts.net:9448"
      PAPERCLIP_STANDBY_BASE='https://adihost4.tailb55406.ts.net:9448'
      PAPERCLIP_API_KEY="pcp_board_test_token"
      PAPERCLIP_COOKIE="better-auth.session_token=sess_abc"
    `);
    expect(parsed).toEqual({
      PAPERCLIP_API_BASE: "https://adi5.tailb55406.ts.net:9448",
      PAPERCLIP_STANDBY_BASE: "https://adihost4.tailb55406.ts.net:9448",
      PAPERCLIP_API_KEY: "pcp_board_test_token",
      PAPERCLIP_COOKIE: "better-auth.session_token=sess_abc",
    });

    const envFile = join(tempRoot, "cyb-board.env");
    writeFileSync(
      envFile,
      "PAPERCLIP_API_KEY=pcp_test_123\nPAPERCLIP_COOKIE=session=xyz\n",
      "utf8",
    );
    const cfg = loadBoardAuthConfig({ boardEnvPath: envFile, env: {} });
    expect(cfg.primaryBase).toBe("https://adi5.tailb55406.ts.net:9448");
    expect(cfg.standbyBase).toBe("https://adihost4.tailb55406.ts.net:9448");
    expect(cfg.bearerToken).toBe("pcp_test_123");
    expect(cfg.cookieHeader).toBe("session=xyz");
  });

  it("fails over automatically from primaryBase to standbyBase on network failure or 503", async () => {
    const calls: Array<{ url: string; method: string; headers: Record<string, string> }> = [];

    const mockFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const headers = Object.fromEntries(new Headers(init?.headers).entries());
      calls.push({ url, method: init?.method ?? "GET", headers });

      if (url.startsWith("https://adi5.tailb55406.ts.net:9448")) {
        throw new TypeError("fetch failed: ECONNREFUSED");
      }
      return new Response(
        JSON.stringify({
          status: "ok",
          deploymentMode: "authenticated",
          deploymentExposure: "private",
          version: "0.4.0",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const client = new PaperclipClient({
      primaryBase: "https://adi5.tailb55406.ts.net:9448",
      standbyBase: "https://adihost4.tailb55406.ts.net:9448",
      bearerToken: "pcp_board_secret",
      fetchImpl: mockFetch as unknown as typeof fetch,
    });

    const health = await client.health();
    expect(health.status).toBe("ok");
    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toBe("https://adi5.tailb55406.ts.net:9448/api/health");
    expect(calls[1]?.url).toBe("https://adihost4.tailb55406.ts.net:9448/api/health");
    expect(calls[1]?.headers.authorization).toBe("Bearer pcp_board_secret");
  });

  it("calls exact Paperclip REST routes for companies, projects (repoUrl without cwd), issues, comments, and activity", async () => {
    const requests: Array<{ url: string; method: string; body: unknown }> = [];

    const mockFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
      requests.push({ url, method, body });

      if (url.endsWith("/api/companies") && method === "GET") {
        return new Response(
          JSON.stringify([
            {
              id: "comp-1",
              name: "01 — Fleet, Harness² & Developer Platform",
              description: "slug:cyb-01-fleet-harness",
              status: "active",
              budgetMonthlyCents: 0,
            },
          ]),
          { status: 200 },
        );
      }
      if (url.endsWith("/api/companies") && method === "POST") {
        return new Response(
          JSON.stringify({
            id: "comp-2",
            name: (body as Record<string, string>).name,
            description: (body as Record<string, string>).description,
            status: "active",
            budgetMonthlyCents: 0,
          }),
          { status: 201 },
        );
      }
      if (url.endsWith("/api/companies/comp-1/projects") && method === "POST") {
        return new Response(
          JSON.stringify({
            id: "proj-1",
            companyId: "comp-1",
            name: (body as Record<string, string>).name,
            status: "in_progress",
          }),
          { status: 201 },
        );
      }
      if (url.includes("/api/companies/comp-1/issues") && method === "GET") {
        return new Response(
          JSON.stringify([
            {
              id: "iss-1",
              companyId: "comp-1",
              projectId: "proj-1",
              title: "[CYB-101] Build sync engine",
              status: "todo",
              priority: "high",
            },
          ]),
          { status: 200 },
        );
      }
      if (url.endsWith("/api/companies/comp-1/issues") && method === "POST") {
        return new Response(
          JSON.stringify({
            id: "iss-2",
            companyId: "comp-1",
            projectId: "proj-1",
            title: (body as Record<string, string>).title,
            status: (body as Record<string, string>).status ?? "todo",
            priority: "medium",
          }),
          { status: 201 },
        );
      }
      if (url.endsWith("/api/issues/iss-1") && method === "PATCH") {
        return new Response(
          JSON.stringify({
            id: "iss-1",
            companyId: "comp-1",
            projectId: "proj-1",
            title: "[CYB-101] Build sync engine",
            status: (body as Record<string, string>).status ?? "in_progress",
            priority: "high",
          }),
          { status: 200 },
        );
      }
      if (url.endsWith("/api/issues/iss-1/comments") && method === "POST") {
        return new Response(
          JSON.stringify({
            id: "cmt-1",
            issueId: "iss-1",
            body: (body as Record<string, string>).body,
          }),
          { status: 201 },
        );
      }
      if (url.includes("/api/companies/comp-1/activity") && method === "GET") {
        return new Response(
          JSON.stringify([
            {
              id: "act-1",
              action: "issue.updated",
              entityType: "issue",
              entityId: "iss-1",
              createdAt: "2026-11-12T08:30:00Z",
            },
          ]),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    });

    const client = new PaperclipClient({
      primaryBase: "https://adi5.tailb55406.ts.net:9448",
      standbyBase: "https://adihost4.tailb55406.ts.net:9448",
      cookieHeader: "better-auth.session_token=abc",
      fetchImpl: mockFetch as unknown as typeof fetch,
    });

    const companies = await client.listCompanies();
    expect(companies).toHaveLength(1);

    const createdCo = await client.createCompany({
      name: "02 — Pentforge",
      description: "slug:cyb-02-pentforge-sec",
    });
    expect(createdCo.id).toBe("comp-2");

    const createdProj = await client.createProject("comp-1", {
      name: "orca-axi",
      repoUrl: "https://github.com/adibirzu/orca-axi",
    });
    expect(createdProj.id).toBe("proj-1");
    const projPost = requests.find((r) => r.url.endsWith("/api/companies/comp-1/projects"));
    expect((projPost?.body as Record<string, any>).workspace).toEqual({
      name: "orca-axi",
      repoUrl: "https://github.com/adibirzu/orca-axi",
      isPrimary: true,
    });
    expect((projPost?.body as Record<string, any>).workspace.cwd).toBeUndefined();

    const issues = await client.listIssues("comp-1", { status: ["todo", "in_progress"] });
    expect(issues[0]?.status).toBe("todo");

    const createdIssue = await client.createIssue("comp-1", {
      title: "[CYB-102] New ticket",
      status: "todo",
      priority: "medium",
      projectId: "proj-1",
    });
    expect(createdIssue.id).toBe("iss-2");

    const updatedIssue = await client.updateIssue("iss-1", { status: "in_review" });
    expect(updatedIssue.status).toBe("in_review");

    await client.addIssueComment("iss-1", "PR opened: https://github.com/adibirzu/orca-axi/pull/6");
    const activity = await client.listActivity("comp-1", { entityType: "issue", entityId: "iss-1" });
    expect(activity).toHaveLength(1);
  });

  it("supports updateCompany, listProjects, updateProject, getIssue, and 503 failover", async () => {
    let attempts = 0;
    const mockFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      attempts += 1;
      if (attempts === 1 && url.startsWith("https://adi5")) {
        return new Response("gateway unavailable", { status: 503 });
      }
      if (url.includes("/api/companies/comp-1/projects") && method === "GET") {
        return new Response(
          JSON.stringify([{ id: "proj-1", companyId: "comp-1", name: "orca-axi" }]),
          { status: 200 },
        );
      }
      if (url.endsWith("/api/companies/comp-1") && method === "PATCH") {
        return new Response(
          JSON.stringify({ id: "comp-1", name: "Updated Co", status: "active", budgetMonthlyCents: 100 }),
          { status: 200 },
        );
      }
      if (url.endsWith("/api/projects/proj-1") && method === "PATCH") {
        return new Response(
          JSON.stringify({ id: "proj-1", companyId: "comp-1", name: "Updated Proj" }),
          { status: 200 },
        );
      }
      if (url.endsWith("/api/issues/iss-1") && method === "GET") {
        return new Response(
          JSON.stringify({
            id: "iss-1",
            companyId: "comp-1",
            title: "[CYB-1] Test",
            status: "todo",
            priority: "low",
          }),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 404 });
    });

    const client = new PaperclipClient({
      primaryBase: "https://adi5.tailb55406.ts.net:9448",
      standbyBase: "https://adihost4.tailb55406.ts.net:9448",
      fetchImpl: mockFetch as unknown as typeof fetch,
    });

    const projs = await client.listProjects("comp-1");
    expect(projs).toHaveLength(1);
    const co = await client.updateCompany("comp-1", { name: "Updated Co", budgetMonthlyCents: 100 });
    expect(co.name).toBe("Updated Co");
    const prj = await client.updateProject("proj-1", { name: "Updated Proj" });
    expect(prj.name).toBe("Updated Proj");
    const iss = await client.getIssue("iss-1");
    expect(iss.id).toBe("iss-1");
  });

  it("never retries or fails over on 409 Conflict", async () => {
    let count = 0;
    const mockFetch = vi.fn(async () => {
      count += 1;
      return new Response(JSON.stringify({ error: "checkout conflict" }), { status: 409 });
    });

    const client = new PaperclipClient({
      primaryBase: "https://adi5.tailb55406.ts.net:9448",
      standbyBase: "https://adihost4.tailb55406.ts.net:9448",
      fetchImpl: mockFetch as unknown as typeof fetch,
    });

    await expect(client.updateIssue("iss-1", { status: "in_progress" })).rejects.toBeInstanceOf(
      PaperclipApiError,
    );
    expect(count).toBe(1);
  });

  it("executes npx paperclipai via inert execFile argv without shell interpolation and forbids pnpm", async () => {
    const spyExec = vi.fn(
      (
        file: string,
        args: readonly string[],
        options: { shell?: boolean },
        cb: (err: Error | null, stdout: string, stderr: string) => void,
      ) => {
        expect(file).toBe("npx");
        expect(args[0]).toBe("paperclipai");
        expect(options.shell).toBe(false);
        cb(null, '{"ok":true}\n', "");
      },
    );

    const out = await runPaperclipCli(["company", "list", "--json"], {
      execFileImpl: spyExec as any,
    });
    expect(out.stdout.trim()).toBe('{"ok":true}');
    expect(spyExec).toHaveBeenCalledTimes(1);

    await expect(
      runPaperclipCli(["pnpm", "paperclipai"], { execFileImpl: spyExec as any }),
    ).rejects.toThrow(/pnpm/i);
  });
});
