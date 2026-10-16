import type { MessageItem, WeixinMessage } from "../src/api/types.js";
import { MessageItemType, MessageType } from "../src/api/types.js";
import { getUpdates, notifyStart, notifyStop } from "./api.js";
import type { BotAuth } from "./api.js";
import { loadState, requireAccount, saveState } from "./state.js";

/** The server returns this when the bot token is no longer valid. */
const STALE_TOKEN_ERRCODE = -14;
const MAX_CONSECUTIVE_FAILURES = 3;
const RETRY_DELAY_MS = 2_000;
const BACKOFF_DELAY_MS = 30_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Retrying cannot fix this, so `listen` stops. */
class StaleTokenError extends Error {}

function describeItem(item: MessageItem): string {
  switch (item.type) {
    case MessageItemType.TEXT:
      return item.text_item?.text ?? "";
    case MessageItemType.IMAGE:
      return "[image]";
    case MessageItemType.VOICE:
      return item.voice_item?.text ? `[voice] ${item.voice_item.text}` : "[voice]";
    case MessageItemType.FILE:
      return `[file] ${item.file_item?.file_name ?? ""}`.trim();
    case MessageItemType.VIDEO:
      return "[video]";
    default:
      return `[type ${item.type ?? "?"}]`;
  }
}

function printMessage(msg: WeixinMessage): void {
  const time = new Date(msg.create_time_ms ?? Date.now()).toLocaleString();
  const body = (msg.item_list ?? []).map(describeItem).join(" ");
  process.stdout.write(`[${time}] ${msg.from_user_id ?? "?"}: ${body}\n`);
}

/**
 * Long-poll for inbound messages and save each sender's context token.
 * `send` needs a fresh token, so keep this running while you use `send`.
 * Mirrors the loop in src/monitor/monitor.ts.
 */
export async function listen(): Promise<void> {
  const state = loadState();
  const account = requireAccount(state);
  const auth: BotAuth = { baseUrl: account.baseUrl, token: account.token };

  let stopping = false;
  const stop = async () => {
    if (stopping) process.exit(130);
    stopping = true;
    process.stdout.write("\nStopping...\n");
    await notifyStop(auth).catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  await notifyStart(auth).catch((err) => {
    process.stderr.write(`notifyStart failed (ignored): ${String(err)}\n`);
  });
  process.stdout.write(`Listening as bot=${account.botId}. Press Ctrl+C to stop.\n`);

  let timeoutMs: number | undefined;
  let failures = 0;

  while (!stopping) {
    try {
      const resp = await getUpdates(auth, state.getUpdatesBuf ?? "", timeoutMs);
      if (resp.longpolling_timeout_ms && resp.longpolling_timeout_ms > 0) {
        timeoutMs = resp.longpolling_timeout_ms;
      }

      const failed = (resp.ret ?? 0) !== 0 || (resp.errcode ?? 0) !== 0;
      if (failed) {
        if (resp.ret === STALE_TOKEN_ERRCODE || resp.errcode === STALE_TOKEN_ERRCODE) {
          throw new StaleTokenError("Bot token expired (errcode -14). Run `login` again.");
        }
        throw new Error(`getUpdates ret=${resp.ret} errcode=${resp.errcode} ${resp.errmsg ?? ""}`);
      }
      failures = 0;

      if (resp.get_updates_buf) state.getUpdatesBuf = resp.get_updates_buf;
      for (const msg of resp.msgs ?? []) {
        if (msg.message_type === MessageType.BOT) continue;
        if (msg.from_user_id && msg.context_token) {
          state.contextTokens[msg.from_user_id] = msg.context_token;
        }
        printMessage(msg);
      }
      saveState(state);
    } catch (err) {
      if (err instanceof StaleTokenError) throw err;
      failures++;
      process.stderr.write(`getUpdates failed (${failures}): ${String(err)}\n`);
      if (failures >= MAX_CONSECUTIVE_FAILURES) {
        failures = 0;
        await sleep(BACKOFF_DELAY_MS);
      } else {
        await sleep(RETRY_DELAY_MS);
      }
    }
  }
}
