/**
 * Read an API response as JSON without allowing Safari's opaque
 * "The string did not match the expected pattern" JSON parse error to hide
 * the actual HTTP failure.  A reverse proxy or a stale app can return HTML
 * (or an empty body) for an API request; reporting the status/content type is
 * much more useful than attempting `response.json()` blindly.
 */
export async function readJsonResponse<T>(response: Response, fallback = "Unexpected server response"): Promise<T> {
  const text = await response.text();
  if (!text.trim()) {
    throw new Error(`${fallback} (HTTP ${response.status})`);
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    const contentType = response.headers.get("content-type") ?? "unknown content type";
    const kind = contentType.toLowerCase().includes("html")
      ? "the server returned an HTML page"
      : "the server returned invalid JSON";
    throw new Error(`${fallback} (HTTP ${response.status}: ${kind})`);
  }
}
