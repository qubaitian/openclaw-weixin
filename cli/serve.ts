import type { MessageItem, WeixinMessage } from "../src/api/types.js";
import { MessageItemType } from "../src/api/types.js";
import { listen } from "./listen.js";

const MAX_TRIES = 3;
const BACKOFF_MS = [1_000, 3_000];
const POST_TIMEOUT_MS = 10_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const ITEM_NAMES: Record<number, string> = {
  [MessageItemType.TEXT]: "text",
  [MessageItemType.IMAGE]: "image",
  [MessageItemType.VOICE]: "voice",
  [MessageItemType.FILE]: "file",
  [MessageItemType.VIDEO]: "video",
};

function itemType(item: MessageItem): string {
  return ITEM_NAMES[item.type ?? -1] ?? `type_${item.type ?? "unknown"}`;
}

function extractText(items: MessageItem[]): string | null {
  const parts: string[] = [];
  for (const it of items) {
    if (it.type === MessageItemType.TEXT && it.text_item?.text) parts.push(it.text_item.text);
    else if (it.type === MessageItemType.VOICE && it.voice_item?.text) parts.push(it.voice_item.text);
  }
  return parts.length ? parts.join("\n") : null;
}

/** Build the webhook payload. Never includes context_token or bot credentials. */
export function buildPayload(msg: WeixinMessage) {
  const items = msg.item_list ?? [];
  return {
    from_user_id: msg.from_user_id ?? null,
    text: extractText(items),
    message_type: msg.message_type ?? null,
    item_types: items.map(itemType),
    create_time: new Date(msg.create_time_ms ?? Date.now()).toISOString(),
    message_id: msg.message_id != null ? String(msg.message_id) : null,
    raw: {
      to_user_id: msg.to_user_id ?? null,
      session_id: msg.session_id ?? null,
      items: items.map((it) => ({
        type: it.type ?? null,
        kind: itemType(it),
        text: it.text_item?.text ?? it.voice_item?.text ?? null,
        file_name: it.file_item?.file_name ?? null,
      })),
    },
  };
}

async function postWithRetry(url: string, auth: string | undefined, body: unknown, id: string) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (auth) headers.Authorization = auth;
  for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(POST_TIMEOUT_MS),
      });
      if (res.ok) {
        process.stdout.write(`webhook ok (message ${id}, HTTP ${res.status})\n`);
        return;
      }
      process.stderr.write(`webhook attempt ${attempt}/${MAX_TRIES} failed: HTTP ${res.status}\n`);
    } catch (err) {
      const reason = err instanceof Error ? `${err.name}: ${err.message}` : "unknown error";
      process.stderr.write(`webhook attempt ${attempt}/${MAX_TRIES} failed: ${reason}\n`);
    }
    if (attempt < MAX_TRIES) await sleep(BACKOFF_MS[attempt - 1] ?? 3_000);
  }
  process.stderr.write(`webhook gave up on message ${id}\n`);
}

/** Long-poll like `listen` and forward each inbound message to $WEIXIN_WEBHOOK_URL. */
export async function serve(): Promise<void> {
  const url = process.env.WEIXIN_WEBHOOK_URL?.trim();
  const auth = process.env.WEIXIN_WEBHOOK_AUTH?.trim() || undefined;
  if (!url) {
    process.stderr.write(
      "WARNING: WEIXIN_WEBHOOK_URL is not set; messages will NOT be forwarded (context tokens are still saved).\n",
    );
  } else {
    let host = "(invalid URL)";
    try {
      host = new URL(url).host;
    } catch {}
    process.stdout.write(
      `Forwarding to webhook host ${host} (auth header: ${auth ? "set" : "not set"})\n`,
    );
  }
  return listen({
    label: "Serving",
    onMessage: async (msg) => {
      if (!url) return;
      const payload = buildPayload(msg);
      await postWithRetry(url, auth, payload, payload.message_id ?? "?");
    },
  });
}
