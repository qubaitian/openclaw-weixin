import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type {
  GetUpdatesResp,
  NotifyStartResp,
  NotifyStopResp,
  SendMessageReq,
  SendMessageResp,
} from "../src/api/types.js";

/**
 * Standalone Weixin iLink API client.
 * It speaks the same protocol as src/api/api.ts but does not load OpenClaw config.
 * See docs/protocol.md for the wire format.
 */

/** API host for QR login. Later calls use the `baseurl` returned by login. */
export const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";

const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
const DEFAULT_API_TIMEOUT_MS = 15_000;

interface PackageJson {
  name?: string;
  version?: string;
  ilink_appid?: string;
}

/** Walk up from this file to the plugin package.json (works from cli/ and dist/cli/). */
function readPackageJson(): PackageJson {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  const { root } = path.parse(dir);
  while (dir !== root) {
    const candidate = path.join(dir, "package.json");
    if (fs.existsSync(candidate)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(candidate, "utf-8")) as PackageJson;
        if (parsed.ilink_appid !== undefined) return parsed;
      } catch {
        // Skip unreadable package.json and keep walking up.
      }
    }
    dir = path.dirname(dir);
  }
  return {};
}

const pkg = readPackageJson();
export const CLI_VERSION = pkg.version ?? "0.0.0";
const ILINK_APP_ID = pkg.ilink_appid ?? "bot";

/** Encode "M.N.P" as 0x00MMNNPP, the same as src/api/api.ts. */
function buildClientVersion(version: string): number {
  const [major = 0, minor = 0, patch = 0] = version.split(".").map((p) => parseInt(p, 10) || 0);
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff);
}

const ILINK_APP_CLIENT_VERSION = String(buildClientVersion(CLI_VERSION));

/** `bot_agent` is for server logs only. It is not used for auth or routing. */
const BOT_AGENT = `WeixinCli/${CLI_VERSION}`;

function buildBaseInfo() {
  return { channel_version: CLI_VERSION, bot_agent: BOT_AGENT };
}

/** X-WECHAT-UIN: random uint32 -> decimal string -> base64. */
function randomWechatUin(): string {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), "utf-8").toString("base64");
}

function appHeaders(): Record<string, string> {
  return {
    "iLink-App-Id": ILINK_APP_ID,
    "iLink-App-ClientVersion": ILINK_APP_CLIENT_VERSION,
  };
}

function postHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "X-WECHAT-UIN": randomWechatUin(),
    ...appHeaders(),
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

function buildUrl(baseUrl: string, endpoint: string): string {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL(endpoint, base).toString();
}

/** Run a fetch with a timeout. Throws AbortError on timeout and Error on HTTP failure. */
async function fetchText(url: string, init: RequestInit, timeoutMs: number): Promise<string> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}: ${text}`);
  return text;
}

/** True when a fetch failed only because our timeout fired. */
export function isTimeout(err: unknown): boolean {
  return err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
}

async function apiPost<T>(params: {
  baseUrl: string;
  endpoint: string;
  body: object;
  token?: string;
  timeoutMs?: number;
}): Promise<T> {
  const text = await fetchText(
    buildUrl(params.baseUrl, params.endpoint),
    { method: "POST", headers: postHeaders(params.token), body: JSON.stringify(params.body) },
    params.timeoutMs ?? DEFAULT_API_TIMEOUT_MS,
  );
  // Plain JSON.parse loses precision on uint64 message IDs.
  // This CLI never sends those IDs back, so it is safe here.
  return JSON.parse(text) as T;
}

// ---------------------------------------------------------------------------
// QR login
// ---------------------------------------------------------------------------

export interface QrCodeResp {
  qrcode: string;
  qrcode_img_content: string;
}

export interface QrStatusResp {
  status:
    | "wait"
    | "scaned"
    | "confirmed"
    | "expired"
    | "scaned_but_redirect"
    | "need_verifycode"
    | "verify_code_blocked"
    | "binded_redirect";
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  ilink_user_id?: string;
  redirect_host?: string;
}

/** `bot_type` used by this channel build. */
const ILINK_BOT_TYPE = "3";

export async function getBotQrCode(localTokens: string[]): Promise<QrCodeResp> {
  return apiPost<QrCodeResp>({
    baseUrl: DEFAULT_BASE_URL,
    endpoint: `ilink/bot/get_bot_qrcode?bot_type=${ILINK_BOT_TYPE}`,
    body: { local_token_list: localTokens },
  });
}

/** Long-poll the QR status. A timeout or network error counts as `wait`. */
export async function getQrCodeStatus(params: {
  baseUrl: string;
  qrcode: string;
  verifyCode?: string;
}): Promise<QrStatusResp> {
  let endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(params.qrcode)}`;
  if (params.verifyCode) endpoint += `&verify_code=${encodeURIComponent(params.verifyCode)}`;
  try {
    const text = await fetchText(
      buildUrl(params.baseUrl, endpoint),
      { method: "GET", headers: appHeaders() },
      DEFAULT_LONG_POLL_TIMEOUT_MS,
    );
    return JSON.parse(text) as QrStatusResp;
  } catch {
    return { status: "wait" };
  }
}

// ---------------------------------------------------------------------------
// Bot API
// ---------------------------------------------------------------------------

export interface BotAuth {
  baseUrl: string;
  token: string;
}

/** Long-poll for inbound messages. A client-side timeout returns an empty result. */
export async function getUpdates(
  auth: BotAuth,
  getUpdatesBuf: string,
  timeoutMs = DEFAULT_LONG_POLL_TIMEOUT_MS,
): Promise<GetUpdatesResp> {
  try {
    return await apiPost<GetUpdatesResp>({
      ...auth,
      endpoint: "ilink/bot/getupdates",
      body: { get_updates_buf: getUpdatesBuf, base_info: buildBaseInfo() },
      timeoutMs,
    });
  } catch (err) {
    if (isTimeout(err)) return { ret: 0, msgs: [], get_updates_buf: getUpdatesBuf };
    throw err;
  }
}

/** Send one message. Throws when `ret` is non-zero. */
export async function sendMessage(auth: BotAuth, body: SendMessageReq): Promise<SendMessageResp> {
  const resp = await apiPost<SendMessageResp>({
    ...auth,
    endpoint: "ilink/bot/sendmessage",
    body: { ...body, base_info: buildBaseInfo() },
  });
  if (resp.ret && resp.ret !== 0) {
    throw new Error(`sendMessage ret=${resp.ret} errmsg=${resp.errmsg ?? "(none)"}`);
  }
  return resp;
}

export async function notifyStart(auth: BotAuth): Promise<NotifyStartResp> {
  return apiPost<NotifyStartResp>({
    ...auth,
    endpoint: "ilink/bot/msg/notifystart",
    body: { base_info: buildBaseInfo() },
  });
}

export async function notifyStop(auth: BotAuth): Promise<NotifyStopResp> {
  return apiPost<NotifyStopResp>({
    ...auth,
    endpoint: "ilink/bot/msg/notifystop",
    body: { base_info: buildBaseInfo() },
  });
}
