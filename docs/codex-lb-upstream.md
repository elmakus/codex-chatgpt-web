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

## Parallel Meta Muse upstream

Codex-LB can remain the primary native upstream while Meta Muse models are routed independently through CLIProxyAPI. The proxies are peers; Codex-LB is not configured behind CLIProxyAPI.

```text
ChatGPT Community Edition / Codex Desktop
                |
                v
       codex-chatgpt-web
          |       |       |
          |       |       `-- muse-* ----------> CLIProxyAPI --> Meta OAuth
          |       `---------- native Codex ----> Codex-LB
          `------------------ chatgpt-web/* ---> ChatGPT Web
```

Keep the existing Codex-LB settings and add the Muse proxy:

```bash
export CODEX_CHATGPT_WEB_NATIVE_UPSTREAM=http://127.0.0.1:2455/backend-api/codex
export CODEX_CHATGPT_WEB_MUSE_UPSTREAM=http://127.0.0.1:8317/v1
```

The Muse hop has a separate ingress API key. It is the API key accepted by CLIProxyAPI itself; Meta OAuth credentials remain owned by CLIProxyAPI and are never stored in this bridge.

```bash
export CODEX_CHATGPT_WEB_MUSE_API_KEY='your-cliproxyapi-ingress-key'
```

For persistent workstation configuration, the Muse key can instead be stored at:

```text
${XDG_CONFIG_HOME:-$HOME/.config}/codex-web-gpt/muse-proxy-api-key
```

or at a custom path selected with `CODEX_CHATGPT_WEB_MUSE_API_KEY_FILE`.

Routing is deterministic by public model ID:

- `muse-*` -> CLIProxyAPI
- every other native model -> existing native/Codex-LB upstream
- `chatgpt-web/*` -> local ChatGPT Web adapter

Model discovery queries both native proxies. Only `muse-*` rows are imported from the CLIProxyAPI catalog, so unrelated providers exposed by that proxy do not appear in ChatGPT CE. If the optional Muse catalog is unavailable, the primary Codex-LB catalog and `chatgpt-web/*` rows remain available.

The same routing rule applies to native Responses, compact, Search, and image requests whenever the request carries a model ID. Provider capability remains authoritative: routing a Muse request to CLIProxyAPI does not imply that Meta supports every Codex endpoint.

## Authentication boundary

Community Edition / Codex Desktop still sends its normal ChatGPT bearer to the local `codex-chatgpt-web` daemon. When a custom native upstream is configured, the network layer requires the dedicated upstream key and replaces `Authorization` before sending the request onward. The original ChatGPT OAuth bearer is therefore never forwarded to the configured custom upstream.

If `CODEX_CHATGPT_WEB_NATIVE_UPSTREAM` is not set, behavior remains unchanged: requests go to `https://chatgpt.com/backend-api/codex` with the incoming native Codex authentication. Merely storing a Codex-LB key does not alter the official route.

## Transport

This integration does not add direct WebSocket passthrough to `codex-chatgpt-web`. The client-to-bridge and bridge-to-Codex-LB native path remains HTTP/SSE.

Codex-LB can still select its own upstream transport toward the Codex backend. In current Codex-LB builds this is configured in the dashboard under **Settings → Routing → Upstream stream transport** with `auto`, `http`, or `websocket`; `auto` is the default. There is no environment variable for that setting.
