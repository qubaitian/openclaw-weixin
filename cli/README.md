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

The CLI only imports `src/api/types.ts` and `src/util/random.ts` from the plugin.  
These two files do not import `openclaw`.
