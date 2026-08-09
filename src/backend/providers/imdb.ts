import { createHash, createHmac } from "node:crypto";
import { db } from "../db";

/**
 * IMDb API client.
 *
 * The IMDb API is a GraphQL endpoint served through AWS Data Exchange:
 *   - endpoint:  https://api-fulfill.dataexchange.us-east-1.amazonaws.com/v1
 *   - auth:      every request must be signed with AWS SigV4 (service
 *                name "dataexchange", region "us-east-1") using long-lived
 *                AWS access keys, plus each subscription's data-set-id,
 *                revision-id, asset-id and its own x-api-key.
 *
 * Credentials are read from the "imdb" config block (see ConfigSchema).
 * This is a skeleton - it is NOT yet wired into the UI/adding-flow, so
 * favourites (subscribing on AWS Data Exchange, testing with a real key)
 * are tracked as TODO follow-ups.
 */

export interface ImdbConfig {
  enabled: boolean;
  apiKey: string;
  awsAccessKeyId: string;
  awsSecretAccessKey: string;
  region: string;
  endpoint: string;
  dataSetId: string;
  revisionId: string;
  assetId: string;
}

interface ImdbRatingsResult {
  data?: {
    title?: {
      ratingsSummary?: {
        aggregateRating?: number;
        voteCount?: number;
      } | null;
    } | null;
  };
}

export function isImdbConfigured(config: ImdbConfig | undefined): boolean {
  return Boolean(
    config?.enabled &&
    (config.apiKey?.length ?? 0) > 0 &&
    (config.awsAccessKeyId?.length ?? 0) > 0 &&
    (config.awsSecretAccessKey?.length ?? 0) > 0 &&
    (config.dataSetId?.length ?? 0) > 0 &&
    (config.revisionId?.length ?? 0) > 0 &&
    (config.assetId?.length ?? 0) > 0,
  );
}

export function loadImdbConfig(): ImdbConfig {
  const raw = db.getSetting("imdb");
  let partial: Partial<ImdbConfig> = {};
  if (raw) {
    try {
      partial = typeof raw === "string" ? JSON.parse(raw) : raw;
    } catch {
      partial = {};
    }
  }
  return {
    enabled: partial.enabled ?? false,
    apiKey: partial.apiKey ?? process.env.IMDB_API_KEY ?? "",
    awsAccessKeyId: partial.awsAccessKeyId ?? process.env.AWS_ACCESS_KEY_ID ?? "",
    awsSecretAccessKey: partial.awsSecretAccessKey ?? process.env.AWS_SECRET_ACCESS_KEY ?? "",
    region: partial.region ?? process.env.IMDB_REGION ?? "us-east-1",
    endpoint: partial.endpoint ?? process.env.IMDB_ENDPOINT ?? "https://api-fulfill.dataexchange.us-east-1.amazonaws.com/v1",
    dataSetId: partial.dataSetId ?? process.env.IMDB_DATA_SET_ID ?? "",
    revisionId: partial.revisionId ?? process.env.IMDB_REVISION_ID ?? "",
    assetId: partial.assetId ?? process.env.IMDB_ASSET_ID ?? "",
  };
}

// ---- AWS SigV4 signing ----------------------------------------------------
//
// Minimal SigV4 for the DataExchange REST API. All components are lowercase
// hex of SHA-256 hashes: canonical request -> string-to-sign -> signature.

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

function sha256Hex(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}

function buildCanonicalRequest(
  uriPath: string,
  method: string,
  headers: Record<string, string>,
  payloadHash: string,
): string {
  const sortedKeys = Object.keys(headers).sort();
  const canonicalHeaders = sortedKeys.map((k) => `${k.toLowerCase()}:${headers[k]!.trim()}\n`).join("");
  return [
    method,
    uriPath,
    "",
    canonicalHeaders,
    sortedKeys.map((k) => k.toLowerCase()).join(";"),
    payloadHash,
  ].join("\n");
}

export function signRequest(input: {
  endpoint: string;
  method?: string;
  query?: string;
  config: ImdbConfig;
}): { url: string; headers: Record<string, string>; body: string } {
  const { endpoint, config } = input;
  const method = input.method ?? "POST";
  const query = input.query ?? "";
  const url = new URL(endpoint);
  let path = url.pathname;
  if (path === "" || path === "/") path = "/v1";
  const uriPath = path + (url.search ? url.search : "");

  const body = JSON.stringify({ query });
  const payloadHash = sha256Hex(body);

  const now = new Date();
  const amzDate = now.toISOString().replace(/[:\-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const host = url.host;

  const requestHeaders: Record<string, string> = {
    "content-type": "application/json",
    host,
    "x-amz-date": amzDate,
    "x-api-key": config.apiKey,
    "x-amz-content-sha256": payloadHash,
    "x-amzn-dataexchange-data-set-id": config.dataSetId,
    "x-amzn-dataexchange-revision-id": config.revisionId,
    "x-amzn-dataexchange-asset-id": config.assetId,
  };

  const canonicalRequest = buildCanonicalRequest(uriPath, method, requestHeaders, payloadHash);
  const algorithm = "AWS4-HMAC-SHA256";
  const credentialScope = `${dateStamp}/${config.region}/dataexchange/aws4_request`;
  const stringToSign = [
    algorithm,
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const kDate = hmac(`AWS4${config.awsSecretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, config.region);
  const kService = hmac(kRegion, "dataexchange");
  const kSigning = hmac(kService, "aws4_request");
  const signature = hmac(kSigning, stringToSign).toString("hex");

  requestHeaders.authorization =
    `${algorithm} Credential=${config.awsAccessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${Object.keys(requestHeaders).sort().map((k) => k.toLowerCase()).join(";")}, ` +
    `Signature=${signature}`;

  return { url: url.origin + uriPath, headers: requestHeaders, body };
}

// ---- Public query API ----------------------------------------------------

/** Fetch the IMDb aggregate rating + vote count for a title id (ttXXXX). */
export async function fetchImdbRatings(imdbId: string): Promise<{ rating?: number; votes?: number } | null> {
  const config = loadImdbConfig();
  if (!isImdbConfigured(config)) {
    return null;
  }
  const { url, headers, body } = signRequest({
    endpoint: config.endpoint,
    query: `{ title(id: "${imdbId}") { ratingsSummary { aggregateRating voteCount } } }`,
    config,
  });

  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body,
    });
    if (!res.ok) return null;
    const json = (await res.json()) as ImdbRatingsResult;
    const summary = json.data?.title?.ratingsSummary ?? null;
    if (!summary) return null;
    return {
      rating: typeof summary.aggregateRating === "number" ? summary.aggregateRating : undefined,
      votes: typeof summary.voteCount === "number" ? summary.voteCount : undefined,
    };
  } catch {
    return null;
  }
}
