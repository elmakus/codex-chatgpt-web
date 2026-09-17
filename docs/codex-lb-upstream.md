# Codex-LB as the native Codex upstream

This fork can keep `chatgpt-web/*` models on the ChatGPT Web adapter while routing native Codex models through Codex-LB.

## Topology

```text
ChatGPT Community Edition / Codex Desktop
                |
                v
       codex-chatgpt-web
          |           |
          |           `-- native Codex models --> Codex-LB --> Codex backend
          `-- chatgpt-web/* -------------> ChatGPT Web
```

The client still points only at the local `codex-chatgpt-web` daemon. Native requests are first built exactly as before, then the network layer rewrites the official Codex backend base URL to the configured upstream. ChatGPT Web models continue to use the browser-backed adapter and are not sent to Codex-LB.

## Configuration

Set the Codex-LB/native upstream URL explicitly, for example:

```bash
export CODEX_CHATGPT_WEB_NATIVE_UPSTREAM=http://127.0.0.1:2455/backend-api/codex
```

A dedicated Codex-LB/native-upstream API key is required whenever that custom upstream is configured. The preferred persistent form is a file owned by the user running `codex-chatgpt-web`:

```text
${XDG_CONFIG_HOME:-$HOME/.config}/codex-web-gpt/codex-lb-api-key
```

The packaged Linux launcher ships a helper that writes the key without putting it in shell history:

```bash
codex-web-gpt-set-codex-lb-key
```

It prompts twice without echoing the value and stores the file with mode `0600`. To remove the stored key:

```bash
codex-web-gpt-set-codex-lb-key --clear
```

`CODEX_LB_API_KEY_FILE` may override the file location. Environment credentials remain supported for standalone deployments:

```bash
export CODEX_CHATGPT_WEB_NATIVE_API_KEY='your-native-upstream-api-key'
# or
export CODEX_LB_API_KEY='your-codex-lb-api-key'
```

Resolution order is `CODEX_CHATGPT_WEB_NATIVE_API_KEY`, then `CODEX_LB_API_KEY`, then the configured/default key file. If no usable key exists, the custom native upstream fails closed before any request is sent.

## Model catalog

Model discovery uses the same native transport as Responses, compaction, Search, and image endpoints. When the native upstream points at Codex-LB, the native model rows returned by Codex-LB are kept and the fork appends its `chatgpt-web/*` rows. The resulting Codex model picker therefore exposes the Codex-LB native catalog together with the ChatGPT Web models supplied by this fork.

## Authentication boundary

Community Edition / Codex Desktop still sends its normal ChatGPT bearer to the local `codex-chatgpt-web` daemon. When a custom native upstream is configured, the network layer requires the dedicated upstream key and replaces `Authorization` before sending the request onward. The original ChatGPT OAuth bearer is therefore never forwarded to the configured custom upstream.

If `CODEX_CHATGPT_WEB_NATIVE_UPSTREAM` is not set, behavior remains unchanged: requests go to `https://chatgpt.com/backend-api/codex` with the incoming native Codex authentication. Merely storing a Codex-LB key does not alter the official route.

## Transport

This integration does not add direct WebSocket passthrough to `codex-chatgpt-web`. The client-to-bridge and bridge-to-Codex-LB native path remains HTTP/SSE.

Codex-LB can still select its own upstream transport toward the Codex backend. In current Codex-LB builds this is configured in the dashboard under **Settings → Routing → Upstream stream transport** with `auto`, `http`, or `websocket`; `auto` is the default. There is no environment variable for that setting.
