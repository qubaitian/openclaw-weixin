import readline from "node:readline/promises";

import { DEFAULT_BASE_URL, getBotQrCode, getQrCodeStatus } from "./api.js";
import { loadState, saveState } from "./state.js";

/** The server lets a QR code expire a few times before we give up. */
const MAX_QR_COUNT = 3;
const LOGIN_TIMEOUT_MS = 8 * 60_000;
const POLL_GAP_MS = 1_000;

async function showQrCode(content: string): Promise<void> {
  try {
    const qrterm = await import("qrcode-terminal");
    qrterm.default.generate(content, { small: true });
  } catch {
    // Fall back to the link below.
  }
  process.stdout.write(`If the QR code does not show, open this link:\n${content}\n`);
}

async function askLine(prompt: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(prompt)).trim();
  } finally {
    rl.close();
  }
}

/**
 * Run the QR login and save the account.
 * Mirrors waitForWeixinLogin() in src/auth/login-qr.ts.
 */
export async function login(): Promise<void> {
  const state = loadState();
  // The server uses old tokens to find a bot this client already owns.
  const localTokens = state.account ? [state.account.token] : [];

  let qr = await getBotQrCode(localTokens);
  let qrCount = 1;
  await showQrCode(qr.qrcode_img_content);
  process.stdout.write("Scan the QR code with WeChat.\n");

  let pollBaseUrl = DEFAULT_BASE_URL;
  let verifyCode: string | undefined;
  let scannedShown = false;
  const deadline = Date.now() + LOGIN_TIMEOUT_MS;

  const refresh = async (): Promise<void> => {
    qrCount++;
    if (qrCount > MAX_QR_COUNT) {
      throw new Error("QR code expired too many times. Try again later.");
    }
    qr = await getBotQrCode(localTokens);
    pollBaseUrl = DEFAULT_BASE_URL;
    scannedShown = false;
    process.stdout.write(`\nNew QR code (${qrCount}/${MAX_QR_COUNT}):\n`);
    await showQrCode(qr.qrcode_img_content);
  };

  while (Date.now() < deadline) {
    const status = await getQrCodeStatus({ baseUrl: pollBaseUrl, qrcode: qr.qrcode, verifyCode });

    switch (status.status) {
      case "wait":
        break;
      case "scaned":
        // A `scaned` after we sent a code means the code was right.
        verifyCode = undefined;
        if (!scannedShown) {
          process.stdout.write("Scanned. Confirm on your phone.\n");
          scannedShown = true;
        }
        break;
      case "need_verifycode":
        verifyCode = await askLine(
          verifyCode
            ? "Wrong number. Enter the number shown in WeChat: "
            : "Enter the number shown in WeChat: ",
        );
        continue;
      case "verify_code_blocked":
        process.stdout.write("Too many wrong numbers.\n");
        verifyCode = undefined;
        await refresh();
        break;
      case "expired":
        process.stdout.write("QR code expired.\n");
        await refresh();
        break;
      case "scaned_but_redirect":
        if (status.redirect_host) pollBaseUrl = `https://${status.redirect_host}`;
        break;
      case "binded_redirect":
        // No new token. The token we already have stays valid.
        process.stdout.write(
          state.account
            ? "This bot is already bound. The saved login is still valid.\n"
            : "This bot is already bound to another client. No new token was issued.\n",
        );
        return;
      case "confirmed": {
        if (!status.ilink_bot_id || !status.bot_token) {
          throw new Error("Login confirmed, but the server did not return a bot ID or token.");
        }
        const sameBot = state.account?.botId === status.ilink_bot_id;
        saveState({
          account: {
            botId: status.ilink_bot_id,
            token: status.bot_token,
            baseUrl: status.baseurl || DEFAULT_BASE_URL,
            userId: status.ilink_user_id,
            savedAt: new Date().toISOString(),
          },
          // Cursor and tokens belong to one bot. Drop them when the bot changes.
          getUpdatesBuf: sameBot ? state.getUpdatesBuf : undefined,
          contextTokens: sameBot ? state.contextTokens : {},
        });
        process.stdout.write(`Logged in. bot=${status.ilink_bot_id}\n`);
        process.stdout.write(
          "Next: run `listen`, then send any message to the bot from WeChat once.\n",
        );
        return;
      }
    }
    await new Promise((r) => setTimeout(r, POLL_GAP_MS));
  }
  throw new Error("Login timed out. Try again.");
}
