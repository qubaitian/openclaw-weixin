import { MessageItemType, MessageState, MessageType } from "../src/api/types.js";
import { generateId } from "../src/util/random.js";
import { sendMessage } from "./api.js";
import { loadState, requireAccount } from "./state.js";

/**
 * Send one text message.
 * `to` defaults to the WeChat user who scanned the QR code.
 * Mirrors buildTextMessageReq() in src/messaging/send.ts.
 */
export async function sendText(params: { text: string; to?: string }): Promise<void> {
  const state = loadState();
  const account = requireAccount(state);
  const to = params.to ?? account.userId;
  if (!to) {
    throw new Error("No target user. Pass --to <userId>.");
  }
  if (!params.text) {
    throw new Error("Message text is empty.");
  }

  const contextToken = state.contextTokens[to];
  if (!contextToken) {
    // The server may reject a send without a token. Try anyway and report what happens.
    process.stderr.write(
      "Warning: no context token for this user. Run `listen` and send the bot a message first.\n",
    );
  }

  const clientId = generateId("weixin-cli");
  const resp = await sendMessage(
    { baseUrl: account.baseUrl, token: account.token },
    {
      msg: {
        from_user_id: "",
        to_user_id: to,
        client_id: clientId,
        message_type: MessageType.BOT,
        message_state: MessageState.FINISH,
        item_list: [{ type: MessageItemType.TEXT, text_item: { text: params.text } }],
        context_token: contextToken,
      },
    },
  );
  process.stdout.write(`Sent. client_id=${clientId} ret=${resp.ret ?? 0}\n`);
}
