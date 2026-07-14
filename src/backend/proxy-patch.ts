import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { SocksProxyAgent } from 'socks-proxy-agent';
import type { RequestOptions } from 'node:http';

const PROXY_URL =
  process.env.ALL_PROXY ||
  process.env.HTTPS_PROXY ||
  process.env.HTTP_PROXY;

const isSocks =
  PROXY_URL !== undefined &&
  (PROXY_URL.startsWith('socks5h://') || PROXY_URL.startsWith('socks5://'));

const noProxyList = (process.env.NO_PROXY || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

function shouldProxy(url: string): boolean {
  if (!isSocks) return false;
  try {
    const host = new URL(url).hostname;
    if (!host) return false;
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return false;
    return !noProxyList.some(p => {
      if (host === p) return true;
      if (p.startsWith('.') && host.endsWith(p)) return true;
      if (host.endsWith('.' + p)) return true;
      return false;
    });
  } catch {
    return false;
  }
}

function hasContentType(headers: Record<string, string>): boolean {
  return Object.keys(headers).some(k => k.toLowerCase() === 'content-type');
}

function headersToRecord(headers: HeadersInit | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  if (!headers) return result;
  if (headers instanceof Headers) {
    headers.forEach((value, key) => { result[key] = value; });
  } else if (Array.isArray(headers)) {
    for (const [key, value] of headers) result[key] = value;
  } else {
    Object.assign(result, headers);
  }
  return result;
}

async function bodyToBuffer(body: BodyInit | null | undefined): Promise<Buffer | null> {
  if (!body) return null;
  if (typeof body === 'string') return Buffer.from(body);
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (body instanceof ArrayBuffer) return Buffer.from(new Uint8Array(body));
  if (body instanceof Blob) return Buffer.from(await body.arrayBuffer());
  if (body instanceof URLSearchParams) return Buffer.from(body.toString());
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

function socks5Fetch(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  agent: SocksProxyAgent,
): Promise<Response> {
  const resource =
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : input.url;

  const method = init?.method || 'GET';
  const headers = headersToRecord(init?.headers);

  // Handle FormData body
  const bodyPromise: Promise<Buffer | null> = !init?.body
    ? Promise.resolve(null)
    : init.body instanceof FormData
      ? (async () => {
          const tempReq = new Request('http://localhost', { method: 'POST', body: init.body! });
          const ct = tempReq.headers.get('content-type');
          if (ct && !hasContentType(headers)) headers['Content-Type'] = ct;
          return Buffer.from(await tempReq.bytes());
        })()
      : bodyToBuffer(init.body);

  return bodyPromise.then(bodyBuffer => {
    if (bodyBuffer && !hasContentType(headers)) {
      headers['Content-Type'] = 'application/octet-stream';
    }

    const useProxy = shouldProxy(resource);
    const requestFn = resource.startsWith('https:') ? httpsRequest : httpRequest;

    return new Promise<Response>((resolve, reject) => {
      const opts: RequestOptions = {
        agent: useProxy ? agent : undefined,
        method,
        headers,
      };
      if (init?.signal) (opts as any).signal = init.signal;

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
      req.on('error', reject);
      if (bodyBuffer) req.write(bodyBuffer);
      req.end();
    });
  });
}

// Patch globalThis.fetch immediately as a side effect of this module being imported
if (PROXY_URL && isSocks) {
  const agent = new SocksProxyAgent(PROXY_URL);
  globalThis.fetch = function patchedFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    return socks5Fetch(input, init, agent);
  } as typeof globalThis.fetch;
  console.log(`[proxy-patch] SOCKS5 proxy active: ${PROXY_URL}`);
  if (noProxyList.length > 0) {
    console.log(`[proxy-patch] Bypassing proxy for: ${noProxyList.join(', ')}`);
  }
}
