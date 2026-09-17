# CLIProxyAPI as native model aggregator

Status: design/proof branch. No production behavior is changed on this branch.

## Goal

Expose all three model families in the ChatGPT Community Edition / Codex Desktop picker:

1. native Codex models backed by Codex-LB
2. Meta Muse models backed by CLIProxyAPI Meta OAuth
3. existing `chatgpt-web/*` models backed by this fork's browser adapter

The preferred first implementation does not add a second native upstream to `codex-chatgpt-web`. CLIProxyAPI already has the provider routing and Codex-client model catalog machinery needed to aggregate native providers.

## Verified baseline

Verified against:

- `elmakus/codex-chatgpt-web` main `f8dc469a43cc562a4173bb77f7a7d9fe2b569187`
- `router-for-me/CLIProxyAPI` main `b773607e3e7756dc6020a291825e4eb08899595a`

Relevant current behavior:

- `codex-chatgpt-web` accepts one custom native upstream through `CODEX_CHATGPT_WEB_NATIVE_UPSTREAM`.
- The configured base path is preserved and the native endpoint suffix is appended.
- Therefore an upstream ending in `/v1` maps:
  - `models -> /v1/models`
  - `responses -> /v1/responses`
  - `responses/compact -> /v1/responses/compact`
  - `alpha/search -> /v1/alpha/search`
  - image endpoints -> `/v1/images/...`
- CLIProxyAPI exposes those `/v1` routes.
- CLIProxyAPI returns Codex-client-shaped model rows from `/v1/models?client_version=...`.
- CLIProxyAPI can register Meta OAuth models and Codex API-key models in the same model registry.
- CLIProxyAPI `codex-api-key` sends Responses traffic to `base-url + /responses`.
- CLIProxyAPI's Meta executor sends Responses traffic to the Meta API and routes by model/provider.
- `codex-chatgpt-web` keeps appending its own `chatgpt-web/*` rows after the native model response.

## Topology

```text
ChatGPT CE / Codex Desktop
          |
          v
  codex-chatgpt-web
     |           |
     |           +--> chatgpt-web/* --> ChatGPT Web browser adapter
     |
     +--> native requests --> CLIProxyAPI /v1
                                |
                                +--> Codex models --> Codex-LB
                                |                    --> Codex backend
                                |
                                +--> Muse models  --> Meta OAuth
                                                     --> api.meta.ai
```

CLIProxyAPI is the native aggregator. `codex-chatgpt-web` remains the single endpoint seen by ChatGPT CE.

## codex-chatgpt-web configuration

For the first proof, existing code is sufficient:

```bash
export CODEX_CHATGPT_WEB_NATIVE_UPSTREAM=http://cliproxyapi:8317/v1
export CODEX_CHATGPT_WEB_NATIVE_API_KEY='<CLIProxyAPI ingress API key>'
```

The second value is the API key accepted by CLIProxyAPI's `api-keys` setting. It is not the Codex-LB key.

Do not set `CODEX_LB_API_KEY` in `codex-chatgpt-web` for this topology unless direct Codex-LB mode is intentionally being tested. The native hop is now:

`codex-chatgpt-web -> CLIProxyAPI`

and the Codex-LB credential belongs on the next hop:

`CLIProxyAPI -> Codex-LB`.

The incoming ChatGPT bearer remains replaced at the existing native-upstream auth boundary before traffic leaves `codex-chatgpt-web`.

## CLIProxyAPI ingress

Minimal server authentication:

```yaml
host: "0.0.0.0"
port: 8317

api-keys:
  - "<key-used-by-codex-chatgpt-web>"
```

On a single-host deployment, bind or firewall this according to the container/network topology. The key must not be committed.

## Codex-LB as a CLIProxyAPI provider

Configure a Codex API-key credential whose base URL ends at Codex-LB's Codex-compatible base:

```yaml
codex-api-key:
  - api-key: "<codex-lb-api-key>"
    base-url: "http://codex-lb:2455/backend-api/codex"
    alpha-search: true
    models:
      - name: "gpt-5.6-sol"
        alias: "gpt-5.6-sol"
      # Add the remaining Codex-LB model slugs that should be exposed.
```

Why the base URL is `.../backend-api/codex`:

CLIProxyAPI's Codex executor appends `/responses`, producing:

`http://codex-lb:2455/backend-api/codex/responses`.

### Catalog caveat

CLIProxyAPI does not automatically mirror Codex-LB's live `/models` response for a `codex-api-key` entry.

- with explicit `models`, those configured aliases are published;
- without explicit `models`, CLIProxyAPI registers its own built-in Codex model set.

For the first proof, explicitly list the current Codex-LB slugs so the picker remains deterministic.

If exact live Codex-LB catalog mirroring becomes a requirement, add that synchronization to the CLIProxyAPI fork rather than teaching `codex-chatgpt-web` provider-specific discovery. That keeps aggregation/provider ownership in the proxy.

## Meta Muse OAuth

Authenticate Meta in CLIProxyAPI with its existing OAuth flow:

```text
-meta-login
```

The resulting Meta auth is registered by CLIProxyAPI and its Muse model(s), including the current `muse-spark-1.3` family/aliases, become part of the same registry used for `/v1/models?client_version=...`.

No Meta credential is stored in `codex-chatgpt-web`.

## Model discovery path

The expected request chain is:

```text
ChatGPT CE
  GET codex-chatgpt-web/v1/models?client_version=X
    -> native passthrough
    -> CLIProxyAPI /v1/models?client_version=X
    -> CLIProxyAPI returns Codex-client model rows for Codex-LB + Meta
    -> codex-chatgpt-web appends chatgpt-web/*
    -> ChatGPT CE receives one merged catalog
```

Expected picker classes:

```text
gpt-*                  -> CLIProxyAPI -> Codex-LB
muse-*                 -> CLIProxyAPI -> Meta OAuth
chatgpt-web/*          -> codex-chatgpt-web browser adapter
```

## Request routing

For a native request, `codex-chatgpt-web` forwards the original model field to CLIProxyAPI.

CLIProxyAPI then selects the provider registered for that model:

- Codex model -> `codex-api-key` credential -> Codex-LB
- Muse model -> Meta OAuth credential -> Meta executor

No model-prefix rewrite is required as long as the public model IDs are unique.

If a future provider collision occurs, solve it in CLIProxyAPI with aliases/prefixes rather than branching routing logic inside `codex-chatgpt-web`.

## Compatibility notes

### Responses

Both routes are compatible with the existing native path:

- Codex-LB receives Codex Responses traffic through CLIProxyAPI's Codex executor.
- Meta receives OpenAI Responses-compatible traffic through CLIProxyAPI's Meta executor.

### Compact

Current CLIProxyAPI Meta execution reports `/responses/compact` as unsupported. Its synthesized fallback Codex-client metadata currently uses a template with no automatic compact threshold, so the initial Muse proof should verify that ChatGPT CE does not issue a compact call during ordinary Muse turns.

If CE does require compact for Muse, handle that as a separate compatibility task. Do not silently send a Muse compact request to Codex-LB.

### Search and images

CLIProxyAPI exposes `/v1/alpha/search` and image routes, but capabilities remain provider/model-specific. The model catalog must not advertise unsupported Muse capabilities merely because Codex-LB supports them.

## Why this is preferred over two native upstreams in codex-chatgpt-web

A two-upstream implementation in this repository would require:

- fetching and merging two external native catalogs
- maintaining model -> upstream ownership
- separate credentials per upstream
- endpoint-specific routing for responses, compact, search, and images
- collision rules and failure policy

CLIProxyAPI already owns most of those provider-routing concerns. Pointing the existing single native-upstream abstraction at its `/v1` API keeps this fork simpler.

## Proof sequence

Before any production merge:

1. Start CLIProxyAPI with one ingress API key.
2. Add Codex-LB as `codex-api-key` with one explicit test model.
3. Complete Meta `-meta-login`.
4. Verify directly:
   - `GET /v1/models?client_version=<current>` contains the Codex test model and Muse.
5. Point a development `codex-chatgpt-web` instance at `http://cliproxyapi:8317/v1`.
6. Verify its model response contains:
   - Codex-LB model
   - Muse model
   - `chatgpt-web/*`
7. Run one Codex turn and confirm traffic reaches Codex-LB.
8. Run one Muse turn and confirm traffic reaches the Meta executor.
9. Run one `chatgpt-web/*` turn and confirm it never reaches CLIProxyAPI.
10. Inspect logs/headers to verify the original ChatGPT bearer is not forwarded to CLIProxyAPI.
11. Test a long Muse conversation far enough to detect any unexpected compact behavior.

## Implementation decision

For the first integration attempt, make no source-code change to `codex-chatgpt-web`.

Only after the live proof should we decide whether the fork needs:

- a generic persistent native-upstream key helper/name instead of the current Codex-LB-oriented helper;
- automated Codex-LB catalog mirroring inside the future CLIProxyAPI fork;
- Muse-specific compact compatibility;
- health/fallback behavior if CLIProxyAPI is unavailable.
