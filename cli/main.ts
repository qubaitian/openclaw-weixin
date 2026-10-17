#!/usr/bin/env node
import { parseArgs } from "node:util";

import { CLI_VERSION } from "./api.js";
import { listen } from "./listen.js";
import { login } from "./login.js";
import { serve } from "./serve.js";
import { sendText } from "./send.js";
import { loadState, resolveStateDir } from "./state.js";

const USAGE = `weixin-cli ${CLI_VERSION}: send WeChat messages without OpenClaw.

Usage:
  weixin-cli login                    Scan a QR code and save the login.
  weixin-cli listen                   Receive messages and save context tokens.
  weixin-cli serve                    Like listen, and POST each message to $WEIXIN_WEBHOOK_URL.
  weixin-cli send [--to <id>] <text>  Send text. Use "-" to read text from stdin.
  weixin-cli status                   Show the saved login.

Default target is the WeChat user who scanned the QR code.
State dir: $WEIXIN_CLI_STATE_DIR or ~/.weixin-cli
`;

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf-8").trim();
}

function status(): void {
  const state = loadState();
  process.stdout.write(`State dir: ${resolveStateDir()}\n`);
  if (!state.account) {
    process.stdout.write("Not logged in.\n");
    return;
  }
  const { account } = state;
  const owner = account.userId;
  process.stdout.write(
    [
      `Bot:      ${account.botId}`,
      `Owner:    ${owner ?? "(unknown)"}`,
      `API host: ${account.baseUrl}`,
      `Saved at: ${account.savedAt}`,
      `Context tokens: ${Object.keys(state.contextTokens).length}` +
        (owner ? ` (owner: ${state.contextTokens[owner] ? "yes" : "no"})` : ""),
      "",
    ].join("\n"),
  );
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      to: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [command, ...rest] = positionals;

  if (values.help || !command) {
    process.stdout.write(USAGE);
    return;
  }

  switch (command) {
    case "login":
      return login();
    case "listen":
      return listen();
    case "serve":
      return serve();
    case "send": {
      const text = rest.length === 1 && rest[0] === "-" ? await readStdin() : rest.join(" ");
      return sendText({ text, to: values.to });
    }
    case "status":
      return status();
    default:
      process.stderr.write(`Unknown command: ${command}\n\n${USAGE}`);
      process.exitCode = 2;
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
