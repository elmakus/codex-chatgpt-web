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

For a local Codex-LB listener on port `2455`:

```bash
export CODEX_CHATGPT_WEB_NATIVE_UPSTREAM=http://127.0.0.1:2455/backend-api/codex
export CODEX_LB_API_KEY='your-existing-codex-lb-api-key'
```

`CODEX_CHATGPT_WEB_NATIVE_API_KEY` may be used instead of `CODEX_LB_API_KEY` when an explicit per-upstream key is preferred:

```bash
export CODEX_CHATGPT_WEB_NATIVE_API_KEY='your-native-upstream-api-key'
```

When both are set, `CODEX_CHATGPT_WEB_NATIVE_API_KEY` wins.

The upstream override applies to all native Codex passthrough endpoints, including model discovery, Responses, compaction, Search, and image endpoints, because those requests share the same native network transport.

## Authentication boundary

Community Edition / Codex Desktop still sends its normal ChatGPT bearer to the local `codex-chatgpt-web` daemon. When a custom native upstream is configured and an upstream API key is present, the network layer replaces `Authorization` before sending the request onward. The original ChatGPT OAuth bearer therefore is not forwarded to Codex-LB.

If `CODEX_CHATGPT_WEB_NATIVE_UPSTREAM` is not set, behavior remains unchanged: requests go to `https://chatgpt.com/backend-api/codex` with the incoming native Codex authentication.

## Transport

This integration does not add direct WebSocket passthrough to `codex-chatgpt-web`. The client-to-bridge and bridge-to-Codex-LB native path remains HTTP/SSE. Codex-LB may still use its own upstream WebSocket transport toward the Codex backend according to its configuration.
