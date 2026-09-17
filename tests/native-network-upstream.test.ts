import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareNativeCodexRequest } from "../src/native-network";

const ENV_KEYS = [
  "CODEX_CHATGPT_WEB_NATIVE_UPSTREAM",
  "CODEX_CHATGPT_WEB_NATIVE_API_KEY",
  "CODEX_LB_API_KEY",
  "CODEX_LB_API_KEY_FILE",
  "XDG_CONFIG_HOME",
] as const;

const originalEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]])) as Record<string, string | undefined>;
const tempRoots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-native-upstream-"));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop()!, { recursive: true, force: true });
  }
});

test("keeps the official backend and incoming OAuth when no native upstream override is configured", async () => {
  delete process.env.CODEX_CHATGPT_WEB_NATIVE_UPSTREAM;
  process.env.CODEX_LB_API_KEY = "lb-secret-that-must-not-be-used";

  const request = new Request("https://chatgpt.com/backend-api/codex/models?client_version=0.151.0", {
    headers: { authorization: "Bearer chatgpt-oauth" },
  });
  const prepared = await prepareNativeCodexRequest(request);

  expect(prepared).toBe(request);
  expect(prepared.url).toBe("https://chatgpt.com/backend-api/codex/models?client_version=0.151.0");
  expect(prepared.headers.get("authorization")).toBe("Bearer chatgpt-oauth");
});

test("rejects a custom native upstream without a dedicated upstream API key", async () => {
  process.env.CODEX_CHATGPT_WEB_NATIVE_UPSTREAM = "http://127.0.0.1:2455/backend-api/codex";
  delete process.env.CODEX_CHATGPT_WEB_NATIVE_API_KEY;
  delete process.env.CODEX_LB_API_KEY;
  process.env.CODEX_LB_API_KEY_FILE = join(tempRoot(), "missing-codex-lb-api-key");

  const request = new Request("https://chatgpt.com/backend-api/codex/models", {
    headers: { authorization: "Bearer chatgpt-oauth-must-not-leak" },
  });

  await expect(prepareNativeCodexRequest(request)).rejects.toThrow(
    "requires a dedicated native/Codex-LB API key",
  );
});

test("reads the persistent Codex-LB key from the default XDG config path", async () => {
  process.env.CODEX_CHATGPT_WEB_NATIVE_UPSTREAM = "http://127.0.0.1:2455/backend-api/codex";
  delete process.env.CODEX_CHATGPT_WEB_NATIVE_API_KEY;
  delete process.env.CODEX_LB_API_KEY;
  delete process.env.CODEX_LB_API_KEY_FILE;
  const configRoot = tempRoot();
  process.env.XDG_CONFIG_HOME = configRoot;
  const keyDir = join(configRoot, "codex-web-gpt");
  mkdirSync(keyDir, { recursive: true });
  writeFileSync(join(keyDir, "codex-lb-api-key"), "  sk-clb-file-key\n", { mode: 0o600 });

  const request = new Request("https://chatgpt.com/backend-api/codex/models", {
    headers: { authorization: "Bearer chatgpt-oauth-must-not-leak" },
  });
  const prepared = await prepareNativeCodexRequest(request);

  expect(prepared.url).toBe("http://127.0.0.1:2455/backend-api/codex/models");
  expect(prepared.headers.get("authorization")).toBe("Bearer sk-clb-file-key");
  expect(prepared.headers.get("authorization")).not.toContain("chatgpt-oauth-must-not-leak");
});

test("routes native Codex requests to Codex-LB and replaces the ChatGPT OAuth bearer", async () => {
  process.env.CODEX_CHATGPT_WEB_NATIVE_UPSTREAM = "http://127.0.0.1:2455/backend-api/codex/";
  delete process.env.CODEX_CHATGPT_WEB_NATIVE_API_KEY;
  process.env.CODEX_LB_API_KEY = "sk-clb-test-key";

  const request = new Request("https://chatgpt.com/backend-api/codex/responses?foo=bar", {
    method: "POST",
    headers: {
      authorization: "Bearer chatgpt-oauth-must-not-leak",
      "content-type": "application/json",
      "x-codex-test": "preserve-me",
    },
    body: JSON.stringify({ model: "gpt-5.6-sol", stream: true }),
  });

  const prepared = await prepareNativeCodexRequest(request);

  expect(prepared.url).toBe("http://127.0.0.1:2455/backend-api/codex/responses?foo=bar");
  expect(prepared.headers.get("authorization")).toBe("Bearer sk-clb-test-key");
  expect(prepared.headers.get("authorization")).not.toContain("chatgpt-oauth-must-not-leak");
  expect(prepared.headers.get("x-codex-test")).toBe("preserve-me");
  expect(await prepared.json()).toEqual({ model: "gpt-5.6-sol", stream: true });
});

test("explicit native API key overrides the persistent Codex-LB key file", async () => {
  process.env.CODEX_CHATGPT_WEB_NATIVE_UPSTREAM = "http://127.0.0.1:2455/backend-api/codex";
  process.env.CODEX_CHATGPT_WEB_NATIVE_API_KEY = "explicit-native-key";
  delete process.env.CODEX_LB_API_KEY;
  const keyFile = join(tempRoot(), "codex-lb-api-key");
  writeFileSync(keyFile, "fallback-file-key", { mode: 0o600 });
  process.env.CODEX_LB_API_KEY_FILE = keyFile;

  const request = new Request("https://chatgpt.com/backend-api/codex/models", {
    headers: { authorization: "Bearer chatgpt-oauth" },
  });
  const prepared = await prepareNativeCodexRequest(request);

  expect(prepared.headers.get("authorization")).toBe("Bearer explicit-native-key");
});

test("rejects invalid native upstream URLs", async () => {
  process.env.CODEX_CHATGPT_WEB_NATIVE_UPSTREAM = "file:///tmp/codex";
  const request = new Request("https://chatgpt.com/backend-api/codex/models", {
    headers: { authorization: "Bearer chatgpt-oauth" },
  });

  await expect(prepareNativeCodexRequest(request)).rejects.toThrow(
    "CODEX_CHATGPT_WEB_NATIVE_UPSTREAM must be an HTTP(S) base URL",
  );
});
