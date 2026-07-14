import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { SocksProxyAgent } from 'socks-proxy-agent';
import type { RequestOptions } from 'node:http';

export interface ProxyConfig {
  url: string | undefined;
  type: 'http' | 'https' | 'socks5' | 'socks5h' | unknown | undefined;
  noProxy: string[];
  enabled: boolean;
}

let originalFetch: typeof globalThis.fetch | null = null;
let socksAgent: SocksProxyAgent | null = null;

export function getProxyConfig(): ProxyConfig {
  const url =
    process.env.ALL_PROXY ||
    process.env.HTTPS_PROXY ||
    process.env.HTTP_PROXY;

  let type: ProxyConfig['type'];
  if (url) {
    if (url.startsWith('socks5h://')) type = 'socks5h';
    else if (url.startsWith('socks5://')) type = 'socks5';
    else if (url.startsWith('https://')) type = 'https';
    else if (url.startsWith('http://')) type = 'http';
    else type = 'unknown';
  }

  return {
    url,
    type,
    noProxy: (process.env.NO_PROXY || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean),
    enabled: !!url,
  };
}

function shouldProxy(url: string, config: ProxyConfig): boolean {
  if (!config.enabled) return false;
  try {
    const host = new URL(url).hostname;
    if (!host) return false;
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return false;
    return !config.noProxy.some(p => {
      if (host === p) return true;
      if (p.startsWith('.') && host.endsWith(p)) return true;
      if (host.endsWith('.' + p)) return true;
      return false;
    });
  } catch {
    return false;
  }
}

function isSocksProxy(url: string): boolean {
  return url.startsWith('socks5h://') || url.startsWith('socks5://');
}

function headersToRecord(headers: HeadersInit | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  if (!headers) return result;
  if (headers instanceof Headers) {
    headers.forEach((value, key) => { result[key] = value; });
  } else if (Array.isArray(headers)) {
    for (const [key, value] of headers) {
      result[key] = value;
    }
  } else {
    Object.assign(result, headers);
  }
  return result;
}

function hasContentType(headers: Record<string, string>): boolean {
  return Object.keys(headers).some(k => k.toLowerCase() === 'content-type');
}

async function bodyToBuffer(body: BodyInit | null | undefined): Promise<Buffer | null> {
  if (!body) return null;

  if (typeof body === 'string') return Buffer.from(body);
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (body instanceof ArrayBuffer) return Buffer.from(new Uint8Array(body));
  if (body instanceof Blob) return Buffer.from(await body.arrayBuffer());
  if (body instanceof URLSearchParams) return Buffer.from(body.toString());
  if (body instanceof FormData) {
    const tempReq = new Request('http://localhost', { method: 'POST', body });
    return Buffer.from(await tempReq.bytes());
  }
  if (body instanceof ReadableStream) {
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    return Buffer.concat(chunks.map(c => Buffer.from(c)));
  }

  return Buffer.from(String(body));
}

async function nodeFetch(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  useProxy: boolean,
): Promise<Response> {
  const resource =
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : input.url;

  const method = init?.method || 'GET';
  const headers = headersToRecord(init?.headers);

  let bodyBuffer: Buffer | null = null;
  if (init?.body instanceof FormData) {
    const tempReq = new Request('http://localhost', { method: 'POST', body: init.body });
    const ct = tempReq.headers.get('content-type');
    if (ct && !hasContentType(headers)) {
      headers['Content-Type'] = ct;
    }
    bodyBuffer = Buffer.from(await tempReq.bytes());
  } else if (init?.body) {
    bodyBuffer = await bodyToBuffer(init.body);
  }

  if (bodyBuffer && !hasContentType(headers)) {
    headers['Content-Type'] = 'application/octet-stream';
  }

  const agent = useProxy ? socksAgent : undefined;
  const requestFn = resource.startsWith('https:') ? httpsRequest : httpRequest;

  return new Promise((resolve, reject) => {
    const opts: RequestOptions = {
      agent,
      method,
      headers,
    };
    if (init?.signal) {
      (opts as any).signal = init.signal;
    }

    const req = requestFn(resource, opts, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const responseHeaders = new Headers();
        for (const [key, value] of Object.entries(res.headers)) {
          if (value === undefined || value === null) continue;
          if (Array.isArray(value)) {
            for (const v of value) responseHeaders.append(key, v);
          } else {
            responseHeaders.set(key, value);
          }
        }

        resolve(
          new Response(Buffer.concat(chunks), {
            status: res.statusCode || 200,
            statusText: res.statusMessage || '',
            headers: responseHeaders,
          }),
        );
      });
    });

    req.on('error', (err) => reject(err));

    if (bodyBuffer) {
      req.write(bodyBuffer);
    }

    req.end();
  });
}

export function applyProxyPatch(): void {
  const config = getProxyConfig();

  if (!config.enabled) {
    console.log(
      '[proxy] No proxy configured (set ALL_PROXY, HTTPS_PROXY, or HTTP_PROXY)',
    );
    return;
  }

  console.log(`[proxy] Routing all outbound fetch() requests through: ${config.url}`);
  if (config.noProxy.length > 0) {
    console.log(`[proxy] Bypassing proxy for: ${config.noProxy.join(', ')}`);
  }

  originalFetch = globalThis.fetch;
  const isSocks = config.url ? isSocksProxy(config.url) : false;

  if (isSocks && config.url) {
    socksAgent = new SocksProxyAgent(config.url);
  }

  if (isSocks) {
    // SOCKS5: never call Bun's native fetch (it rejects SOCKS5 at the C++ level).
    // Use node:http/https with SocksProxyAgent for all requests.
    globalThis.fetch = function patchedFetch(
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url;

      const useProxy = shouldProxy(url, config);
      return nodeFetch(input, init, useProxy);
    } as typeof globalThis.fetch;
  } else {
    // HTTP/HTTPS proxy: use Bun's native proxy option
    globalThis.fetch = function patchedFetch(
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url;

      if (!shouldProxy(url, config)) {
        return originalFetch!(input, init);
      }

      return originalFetch!(input, { ...init, proxy: config.url } as any);
    } as typeof globalThis.fetch;
  }
}

export function removeProxyPatch(): void {
  if (originalFetch) {
    globalThis.fetch = originalFetch;
    originalFetch = null;
  }
}
