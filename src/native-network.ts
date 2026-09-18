import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readLauncherBrowserHostDescriptor } from "./launcher-browser-host";

const OFFICIAL_CODEX_BACKEND = new URL("https://chatgpt.com/backend-api/codex");

type NativeUpstreamRoute = "auto" | "native" | "muse";

function proxyError(message: string): Error {
  return Object.assign(new Error(message), { code: "NativeProxyConfigurationError" });
}

function configuredUpstream(raw: string | undefined, name: string): URL | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  let upstream: URL;
  try {
    upstream = new URL(value);
  } catch {
    throw proxyError(`${name} must be a valid HTTP(S) URL`);
  }
  if ((upstream.protocol !== "http:" && upstream.protocol !== "https:")
    || upstream.username || upstream.password || upstream.search || upstream.hash) {
    throw proxyError(`${name} must be an HTTP(S) base URL without credentials, query, or fragment`);
  }
  upstream.pathname = upstream.pathname.replace(/\/+$/, "");
  return upstream;
}

function nativeUpstreamBase(): URL | undefined {
  return configuredUpstream(
    process.env.CODEX_CHATGPT_WEB_NATIVE_UPSTREAM,
    "CODEX_CHATGPT_WEB_NATIVE_UPSTREAM",
  );
}

function museUpstreamBase(): URL | undefined {
  return configuredUpstream(
    process.env.CODEX_CHATGPT_WEB_MUSE_UPSTREAM,
    "CODEX_CHATGPT_WEB_MUSE_UPSTREAM",
  );
}

export function hasMuseNativeUpstream(): boolean {
  return Boolean(process.env.CODEX_CHATGPT_WEB_MUSE_UPSTREAM?.trim());
}

function defaultCodexLbApiKeyFile(): string | undefined {
  const xdgConfigHome = process.env.XDG_CONFIG_HOME?.trim();
  if (xdgConfigHome) return join(xdgConfigHome, "codex-web-gpt", "codex-lb-api-key");
  const home = process.env.HOME?.trim();
  if (home) return join(home, ".config", "codex-web-gpt", "codex-lb-api-key");
  return undefined;
}

function defaultMuseApiKeyFile(): string | undefined {
  const xdgConfigHome = process.env.XDG_CONFIG_HOME?.trim();
  if (xdgConfigHome) return join(xdgConfigHome, "codex-web-gpt", "muse-proxy-api-key");
  const home = process.env.HOME?.trim();
  if (home) return join(home, ".config", "codex-web-gpt", "muse-proxy-api-key");
  return undefined;
}

function apiKeyFromFile(keyFile: string | undefined, label: string): string | undefined {
  if (!keyFile) return undefined;

  let raw: string;
  try {
    raw = readFileSync(keyFile, "utf8");
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;
    if (code === "ENOENT") return undefined;
    throw proxyError(`Could not read ${label} API key file: ${keyFile}`);
  }

  const key = raw.trim();
  if (!key) throw proxyError(`${label} API key file is empty: ${keyFile}`);
  return key;
}

function codexLbApiKeyFromFile(): string | undefined {
  const keyFile = process.env.CODEX_LB_API_KEY_FILE?.trim() || defaultCodexLbApiKeyFile();
  return apiKeyFromFile(keyFile, "Codex-LB");
}

function museApiKeyFromFile(): string | undefined {
  const keyFile = process.env.CODEX_CHATGPT_WEB_MUSE_API_KEY_FILE?.trim() || defaultMuseApiKeyFile();
  return apiKeyFromFile(keyFile, "Muse/CLIProxyAPI");
}

function nativeUpstreamApiKey(): string | undefined {
  // Explicit environment credentials remain supported for standalone deployments.
  // The persistent-file fallback is the normal workstation path and is read by this fork itself.
  return process.env.CODEX_CHATGPT_WEB_NATIVE_API_KEY?.trim()
    || process.env.CODEX_LB_API_KEY?.trim()
    || codexLbApiKeyFromFile();
}

function museUpstreamApiKey(): string | undefined {
  return process.env.CODEX_CHATGPT_WEB_MUSE_API_KEY?.trim()
    || museApiKeyFromFile();
}

export function isMuseNativeModel(model: string | undefined): boolean {
  return Boolean(model?.startsWith("muse-"));
}

async function requestModel(request: Request): Promise<string | undefined> {
  const method = request.method.toUpperCase();
  if (method === "GET" || method === "HEAD") return undefined;
  try {
    const value = await request.clone().json() as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const model = (value as { model?: unknown }).model;
    return typeof model === "string" && /^[A-Za-z0-9_./:-]{1,128}$/.test(model) ? model : undefined;
  } catch {
    return undefined;
  }
}

function rewriteNativeCodexRequest(request: Request, upstream: URL, apiKey: string): Promise<Request> {
  const source = new URL(request.url);
  const officialPath = OFFICIAL_CODEX_BACKEND.pathname.replace(/\/+$/, "");
  if (source.origin !== OFFICIAL_CODEX_BACKEND.origin
    || (source.pathname !== officialPath && !source.pathname.startsWith(`${officialPath}/`))) {
    throw proxyError("Native Codex upstream rewrite received an unexpected source URL");
  }

  const suffix = source.pathname.slice(officialPath.length);
  const target = new URL(upstream.href);
  target.pathname = `${target.pathname.replace(/\/+$/, "")}${suffix}`;
  target.search = source.search;

  const headers = new Headers(request.headers);
  headers.set("authorization", `Bearer ${apiKey}`);

  const method = request.method.toUpperCase();
  return request.arrayBuffer().then(body => new Request(target, {
    method: request.method,
    headers,
    ...(method === "GET" || method === "HEAD" ? {} : { body }),
    signal: request.signal,
    redirect: request.redirect,
  }));
}

/**
 * Rewrite an official Codex backend request to the configured parallel native upstream.
 *
 * Native Codex models use CODEX_CHATGPT_WEB_NATIVE_UPSTREAM. Muse model IDs use the optional
 * CODEX_CHATGPT_WEB_MUSE_UPSTREAM instead. Each upstream owns a separate API key so the incoming
 * ChatGPT OAuth bearer is never forwarded to either configured proxy.
 */
export async function prepareNativeCodexRequest(
  request: Request,
  route: NativeUpstreamRoute = "auto",
): Promise<Request> {
  const model = route === "auto" ? await requestModel(request) : undefined;
  const selectedRoute = route === "auto"
    ? (hasMuseNativeUpstream() && isMuseNativeModel(model) ? "muse" : "native")
    : route;

  if (selectedRoute === "muse") {
    const upstream = museUpstreamBase();
    if (!upstream) {
      throw proxyError("Muse native routing requires CODEX_CHATGPT_WEB_MUSE_UPSTREAM");
    }
    const apiKey = museUpstreamApiKey();
    if (!apiKey) {
      throw proxyError(
        "CODEX_CHATGPT_WEB_MUSE_UPSTREAM requires CODEX_CHATGPT_WEB_MUSE_API_KEY"
        + " or a non-empty Muse/CLIProxyAPI API key file",
      );
    }
    return rewriteNativeCodexRequest(request, upstream, apiKey);
  }

  const upstream = nativeUpstreamBase();
  if (!upstream) return request;

  const apiKey = nativeUpstreamApiKey();
  if (!apiKey) {
    throw proxyError(
      "CODEX_CHATGPT_WEB_NATIVE_UPSTREAM requires a dedicated native/Codex-LB API key or a non-empty Codex-LB API key file",
    );
  }
  return rewriteNativeCodexRequest(request, upstream, apiKey);
}

/** Use the first route selected by Chromium, without guessing another proxy protocol or retrying. */
export function nativeProxyFromPac(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 4096) {
    throw proxyError("Launcher returned invalid native proxy configuration");
  }
  const first = value.split(";")[0]!.trim();
  if (first === "DIRECT") return undefined;
  const match = /^(PROXY|HTTPS) ([^\s/;]+)$/.exec(first);
  if (!match) {
    throw proxyError("Native Codex requires an HTTP(S) system proxy; the selected proxy protocol is unsupported");
  }
  try {
    const proxy = new URL(`${match[1] === "HTTPS" ? "https" : "http"}://${match[2]}`);
    if (!proxy.hostname || proxy.username || proxy.password || proxy.search || proxy.hash) throw new Error();
    return proxy.href;
  } catch {
    throw proxyError("Launcher returned invalid native proxy configuration");
  }
}

async function fetchPreparedNativeCodex(upstreamRequest: Request): Promise<Response> {
  const descriptorPath = process.env.CODEX_CHATGPT_WEB_BROWSER_HOST_DESCRIPTOR?.trim();
  // Standalone CLI and explicitly configured proxy environments retain Bun's existing semantics,
  // including NO_PROXY. No proxy variables or machine-wide settings are rewritten.
  if (!descriptorPath || ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]
    .some(key => process.env[key]?.trim())) return fetch(upstreamRequest);

  const descriptor = readLauncherBrowserHostDescriptor(descriptorPath);
  const response = await fetch(`${descriptor.control.endpoint}/v1/network/resolve-proxy`, {
    method: "POST",
    headers: { authorization: `Bearer ${descriptor.control.token}`, "content-type": "application/json" },
    body: JSON.stringify({ url: upstreamRequest.url }),
    signal: AbortSignal.any([upstreamRequest.signal, AbortSignal.timeout(10_000)]),
    redirect: "error",
  });
  if (!response.ok) throw proxyError(`Launcher native proxy resolution failed (HTTP ${response.status})`);
  const result = await response.json() as { proxy?: unknown };
  const proxy = nativeProxyFromPac(result.proxy);
  return fetch(upstreamRequest, proxy ? { proxy } : undefined);
}

/** Native Codex keeps its own auth and Bun transport, but shares the launcher's OS proxy policy. */
export async function fetchNativeCodex(request: Request): Promise<Response> {
  return fetchPreparedNativeCodex(await prepareNativeCodexRequest(request));
}

/** Force one request through the configured Muse/CLIProxyAPI upstream, used for model discovery. */
export async function fetchMuseCodex(request: Request): Promise<Response> {
  return fetchPreparedNativeCodex(await prepareNativeCodexRequest(request, "muse"));
}
