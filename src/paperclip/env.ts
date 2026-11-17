import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const DEFAULT_PRIMARY_API_BASE = "https://adi5.tailb55406.ts.net:9448";
export const DEFAULT_STANDBY_API_BASE = "https://adihost4.tailb55406.ts.net:9448";

export interface BoardAuthConfig {
  readonly primaryBase: string;
  readonly standbyBase: string;
  readonly bearerToken?: string;
  readonly cookieHeader?: string;
  readonly boardEnvPath: string;
  readonly boardEnvPresent: boolean;
}

export interface LoadBoardAuthOptions {
  readonly boardEnvPath?: string;
  readonly homeDir?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface RunPaperclipCliOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
  readonly execFileImpl?: typeof execFile;
}

function stripWrappingQuotes(raw: string): string {
  const trimmed = raw.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

export function parseBoardEnv(rawText: string): Readonly<Record<string, string>> {
  const entries: Record<string, string> = {};
  for (const line of rawText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const withoutExport = trimmed.startsWith("export ")
      ? trimmed.slice("export ".length).trim()
      : trimmed;
    const eqIdx = withoutExport.indexOf("=");
    if (eqIdx <= 0) continue;
    const key = withoutExport.slice(0, eqIdx).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    entries[key] = stripWrappingQuotes(withoutExport.slice(eqIdx + 1));
  }
  return entries;
}

export function loadBoardAuthConfig(options: LoadBoardAuthOptions = {}): BoardAuthConfig {
  const env = options.env ?? process.env;
  const home = options.homeDir ?? homedir();
  const boardEnvPath = resolve(
    options.boardEnvPath ??
      env.PAPERCLIP_BOARD_ENV?.trim() ??
      join(home, ".paperclip", "cyb-board.env"),
  );

  const filePresent = existsSync(boardEnvPath);
  const fileVars = filePresent ? parseBoardEnv(readFileSync(boardEnvPath, "utf8")) : {};
  const merged: Record<string, string | undefined> = { ...fileVars, ...env };

  const primaryBase = normalizeBaseUrl(
    merged.PAPERCLIP_API_BASE || merged.PAPERCLIP_API_URL || DEFAULT_PRIMARY_API_BASE,
  );
  const standbyBase = normalizeBaseUrl(
    merged.PAPERCLIP_STANDBY_BASE ||
      merged.PAPERCLIP_FALLBACK_API_URL ||
      merged.PAPERCLIP_FALLBACK_URL ||
      DEFAULT_STANDBY_API_BASE,
  );
  const bearerToken = (
    merged.PAPERCLIP_API_KEY ||
    merged.PAPERCLIP_BOARD_API_KEY ||
    merged.PAPERCLIP_BOARD_TOKEN ||
    merged.PAPERCLIP_TOKEN ||
    ""
  ).trim();
  const cookieHeader = (
    merged.PAPERCLIP_COOKIE ||
    merged.PAPERCLIP_SESSION_COOKIE ||
    ""
  ).trim();

  return {
    primaryBase,
    standbyBase,
    ...(bearerToken ? { bearerToken } : {}),
    ...(cookieHeader ? { cookieHeader } : {}),
    boardEnvPath,
    boardEnvPresent: filePresent,
  };
}

export async function runPaperclipCli(
  args: readonly string[],
  options: RunPaperclipCliOptions = {},
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  for (const arg of args) {
    if (typeof arg !== "string") {
      throw new TypeError("All paperclipai CLI arguments must be strings");
    }
    if (arg.trim().toLowerCase() === "pnpm") {
      throw new Error(
        "Invoking pnpm paperclipai is forbidden per Paperclip CLI policy; use npx paperclipai",
      );
    }
  }

  const runner = options.execFileImpl ?? execFile;
  return new Promise((resolvePromise, rejectPromise) => {
    runner(
      "npx",
      ["paperclipai", ...args],
      {
        cwd: options.cwd,
        env: options.env ?? process.env,
        shell: false,
        timeout: options.timeoutMs ?? 20_000,
        maxBuffer: 8 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        if (err) {
          rejectPromise(err);
          return;
        }
        resolvePromise({ stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}
