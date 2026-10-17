# weixin-cli

`weixin-cli` sends WeChat messages without OpenClaw.  
It uses the same Weixin iLink bot API as the plugin.  
See [the protocol doc](../docs/protocol.md) for the wire format.

## Build

```bash
npm ci --ignore-scripts --include=dev
npm run build:cli
```

The build output is in `dist/cli/`.  
The CLI does not load the `openclaw` package at run time.  
(`npm ci` still installs `openclaw` because the plugin uses it as a dev dependency.)

## Use

1. Log in once.  
   Scan the QR code with WeChat and confirm on your phone.

   ```bash
   npm run cli -- login
   ```

2. Start `listen`.  
   Then send any message to the bot from WeChat.  
   `listen` saves the `context_token` from that message.

   ```bash
   npm run cli -- listen
   ```

3. Send a message.  
   The default target is the WeChat user who scanned the QR code.

   ```bash
   npm run cli -- send "hello"
   ```

   Read the text from stdin with `-`:

   ```bash
   echo "build done" | npm run cli -- send -
   ```

   Send to another user with `--to <userId>`.  
   That user must message the bot first.

4. Check the saved login.

   ```bash
   npm run cli -- status
   ```

## Context token

The server gives a `context_token` with each inbound message.  
Every send must echo the last token of that user.  
So the user must message the bot at least once before `send` works.  
Keep `listen` running to keep the token fresh.  
The server rules for token lifetime are not documented.  
`send` without a token prints a warning and tries anyway.

## State

The state file is `~/.weixin-cli/state.json`.  
Set `WEIXIN_CLI_STATE_DIR` to use another folder.  
The file holds the bot token, so it is written with mode `0600`.  
It does not share state with the OpenClaw plugin (`~/.openclaw`).

## Code

| File        | Job                                  |
| ----------- | ------------------------------------ |
| `api.ts`    | HTTP calls, headers, and `base_info` |
| `login.ts`  | QR login flow                        |
| `listen.ts` | Long poll and context token store    |
| `send.ts`   | Text send                            |
| `state.ts`  | State file                           |
| `main.ts`   | Command line entry                   |
| `serve.ts`  | Long poll + POST to webhook URL      |

The CLI only imports `src/api/types.ts` and `src/util/random.ts` from the plugin.  
These two files do not import `openclaw`.

## Webhook service (`serve`)

`serve` long-polls WeChat iLink messages (same loop as `listen`, and still saves context tokens) and POSTs each inbound message as JSON to a Grok Bot / Cursor webhook automation.

### Required env

| Variable | Meaning |
| --- | --- |
| `WEIXIN_WEBHOOK_URL` | Automation webhook URL |
| `WEIXIN_WEBHOOK_AUTH` | Full `Authorization` header, typically `Bearer <YOUR_WEBHOOK_KEY>` |

How to get them in Grok Bot: create a webhook-trigger routine, then open **Webhook URL** / **Webhook key** / **Authorization header** from the automation sidebar.

```bash
# Login must be done first
npm run cli -- login

export WEIXIN_WEBHOOK_URL='https://api2.cursor.sh/automations/webhook/<YOUR_WEBHOOK_ID>'
export WEIXIN_WEBHOOK_AUTH='Bearer <YOUR_WEBHOOK_KEY>'
npm run cli -- serve
```

Put secrets in the environment or a mode-`600` local file. Never commit them to the repo.

Failed POSTs are retried 3 times with a short backoff. If `WEIXIN_WEBHOOK_URL` is unset, `serve` logs a warning and keeps listening (context tokens are still saved).

Payload: `{ from_user_id, text, message_type, item_types, create_time, message_id, raw: { to_user_id, session_id, items[] } }`. Context tokens and the bot token are never sent.
