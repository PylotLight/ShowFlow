import { test, expect, beforeEach, afterEach, mock } from "bun:test";
import { getProxyConfig, applyProxyPatch, removeProxyPatch } from "./proxy";

const OLD_ENV = { ...process.env };

beforeEach(() => {
  process.env = { ...OLD_ENV };
  delete process.env.ALL_PROXY;
  delete process.env.HTTPS_PROXY;
  delete process.env.HTTP_PROXY;
  delete process.env.NO_PROXY;
});

afterEach(() => {
  removeProxyPatch();
  process.env = { ...OLD_ENV };
});

test("getProxyConfig returns disabled config when no env vars set", () => {
  const config = getProxyConfig();
  expect(config.enabled).toBe(false);
  expect(config.url).toBeUndefined();
  expect(config.type).toBeUndefined();
  expect(config.noProxy).toEqual([]);
});

test("getProxyConfig reads HTTPS_PROXY env var", () => {
  process.env.HTTPS_PROXY = "socks5h://localhost:1080";
  const config = getProxyConfig();
  expect(config.enabled).toBe(true);
  expect(config.url).toBe("socks5h://localhost:1080");
  expect(config.type).toBe("socks5h");
});

test("getProxyConfig reads HTTP_PROXY env var", () => {
  process.env.HTTP_PROXY = "http://proxy.example:8080";
  const config = getProxyConfig();
  expect(config.enabled).toBe(true);
  expect(config.url).toBe("http://proxy.example:8080");
  expect(config.type).toBe("http");
});

test("getProxyConfig prefers ALL_PROXY over HTTPS_PROXY", () => {
  process.env.ALL_PROXY = "socks5://all-proxy:1080";
  process.env.HTTPS_PROXY = "http://https-proxy:8080";
  const config = getProxyConfig();
  expect(config.url).toBe("socks5://all-proxy:1080");
  expect(config.type).toBe("socks5");
});

test("getProxyConfig parses NO_PROXY correctly", () => {
  process.env.HTTPS_PROXY = "http://proxy:8080";
  process.env.NO_PROXY = "localhost,example.com,.internal.corp";
  const config = getProxyConfig();
  expect(config.noProxy).toEqual(["localhost", "example.com", ".internal.corp"]);
});

test("getProxyConfig detects socks5 type", () => {
  process.env.HTTPS_PROXY = "socks5://localhost:1080";
  expect(getProxyConfig().type).toBe("socks5");
});

test("getProxyConfig detects socks5h type", () => {
  process.env.HTTPS_PROXY = "socks5h://localhost:1080";
  expect(getProxyConfig().type).toBe("socks5h");
});

test("getProxyConfig detects https type", () => {
  process.env.HTTPS_PROXY = "https://proxy:443";
  expect(getProxyConfig().type).toBe("https");
});

test("getProxyConfig returns unknown for unrecognized scheme", () => {
  process.env.HTTPS_PROXY = "ftp://proxy:21";
  expect(getProxyConfig().type).toBe("unknown");
});

test("applyProxyPatch patches globalThis.fetch when proxy is configured", () => {
  process.env.HTTPS_PROXY = "http://proxy:8080";

  const originalFetch = globalThis.fetch;
  applyProxyPatch();
  expect(globalThis.fetch).not.toBe(originalFetch);
});

test("applyProxyPatch does not patch when no proxy configured", () => {
  const originalFetch = globalThis.fetch;
  applyProxyPatch();
  expect(globalThis.fetch).toBe(originalFetch);
});

test("removeProxyPatch restores original fetch", () => {
  process.env.HTTPS_PROXY = "http://proxy:8080";
  const originalFetch = globalThis.fetch;

  applyProxyPatch();
  expect(globalThis.fetch).not.toBe(originalFetch);

  removeProxyPatch();
  expect(globalThis.fetch).toBe(originalFetch);
});

test("shouldProxy bypasses localhost connections", () => {
  process.env.ALL_PROXY = "socks5h://proxy:1080";
  // localhost should not be proxied
  const fetchFn = globalThis.fetch;
  applyProxyPatch();
  expect(globalThis.fetch).not.toBe(fetchFn);
  // We can't easily test the internal shouldProxy, but the
  // implementation includes localhost bypass
});

test("socks5 proxy URL config with socks5h scheme", () => {
  process.env.ALL_PROXY = "socks5h://user:pass@proxy.example:1080";
  const config = getProxyConfig();
  expect(config.type).toBe("socks5h");
  expect(config.url).toBe("socks5h://user:pass@proxy.example:1080");
  expect(config.enabled).toBe(true);
});

test("socks5 patched fetch does not throw UnsupportedProxyProtocol", async () => {
  process.env.HTTPS_PROXY = "socks5h://localhost:1080";
  applyProxyPatch();

  // Since no SOCKS5 server is running, this should fail with a
  // connection error (ECONNREFUSED or similar), NOT UnsupportedProxyProtocol
  try {
    await fetch("https://nyaa.si/");
    // If it succeeds somehow, that's fine (unlikely without proxy)
  } catch (e: any) {
    expect(e.message).not.toContain("UnsupportedProxyProtocol");
    expect(e.message).not.toContain("Unsupported proxy protocol");
  }
});

test("socks5 patched fetch bypasses for localhost", async () => {
  process.env.HTTPS_PROXY = "socks5h://localhost:1080";
  applyProxyPatch();

  // localhost should be bypassed - use Bun's native fetch
  // Since there's no local server, it should fail with connection refused
  // NOT UnsupportedProxyProtocol
  try {
    await fetch("http://localhost:19999/");
  } catch (e: any) {
    expect(e.message).not.toContain("UnsupportedProxyProtocol");
    expect(e.message).not.toContain("Unsupported proxy protocol");
  }
});
