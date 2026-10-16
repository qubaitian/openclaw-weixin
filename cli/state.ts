import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Local state for the standalone CLI.
 * One JSON file holds the login, the getUpdates cursor, and context tokens.
 * The file holds the bot token, so it is written with mode 0600.
 */

export interface Account {
  /** `ilink_bot_id` from login. */
  botId: string;
  /** `bot_token` from login. This is the credential. */
  token: string;
  /** API host returned by login. */
  baseUrl: string;
  /** `ilink_user_id`: the WeChat user who scanned the QR code. */
  userId?: string;
  savedAt: string;
}

export interface CliState {
  account?: Account;
  /** Cursor for the next getUpdates call. */
  getUpdatesBuf?: string;
  /** Last `context_token` per user ID, taken from inbound messages. */
  contextTokens: Record<string, string>;
}

export function resolveStateDir(): string {
  return process.env.WEIXIN_CLI_STATE_DIR?.trim() || path.join(os.homedir(), ".weixin-cli");
}

function resolveStatePath(): string {
  return path.join(resolveStateDir(), "state.json");
}

export function loadState(): CliState {
  try {
    const parsed = JSON.parse(fs.readFileSync(resolveStatePath(), "utf-8")) as Partial<CliState>;
    return { ...parsed, contextTokens: parsed.contextTokens ?? {} };
  } catch {
    return { contextTokens: {} };
  }
}

/** Write to a temp file, then rename, so a crash never leaves a half-written file. */
export function saveState(state: CliState): void {
  const dir = resolveStateDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = resolveStatePath();
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { encoding: "utf-8", mode: 0o600 });
  fs.renameSync(tmp, target);
}

/** Load state and fail with a clear message when nobody has logged in. */
export function requireAccount(state: CliState): Account {
  if (!state.account) {
    throw new Error("Not logged in. Run `login` first.");
  }
  return state.account;
}
