import https from "node:https";

const MAX_REDIRECTS = 10;
const REQUEST_TIMEOUT_MS = 30000;

export function headersFor(url) {
  const headers = { "user-agent": "yard-binaries-refresh" };
  if (new URL(url).hostname === "api.github.com") {
    headers.accept = "application/vnd.github+json";
    headers["x-github-api-version"] = "2022-11-28";
  }
  return headers;
}

function request(url, { method }) {
  return new Promise((resolvePromise, reject) => {
    const req = https.get(
      url,
      { timeout: REQUEST_TIMEOUT_MS, method, headers: headersFor(url) },
      (response) => {
      const status = response.statusCode ?? 0;
      const location = response.headers.location;
      if (status >= 300 && status < 400 && location) {
        response.resume();
        resolvePromise({ status, headers: response.headers, text: "" });
        return;
      }
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        text += chunk;
      });
      response.on("end", () => resolvePromise({ status, headers: response.headers, text }));
      response.on("error", reject);
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`request stalled after ${REQUEST_TIMEOUT_MS}ms: ${url}`));
    });
  });
}

export async function followRedirects(url, { follow = true, requestImpl = request, maxRedirects = MAX_REDIRECTS } = {}) {
  let current = url;
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const response = await requestImpl(current, { method: "GET" });
    const isRedirect = response.status >= 300 && response.status < 400 && response.headers?.location;
    if (!isRedirect || !follow) {
      return response;
    }
    current = new URL(response.headers.location, current).toString();
  }
  throw new Error(`too many redirects resolving ${url}`);
}

export async function getUrl(url, { follow = true } = {}) {
  if (!url.startsWith("https://")) {
    throw new Error(
      `refusing to fetch '${url}' — only https is supported, on every hop, because a vendor artifact fetched over plain http cannot be trusted even when a digest is checked afterwards (the digest itself arrives over the same channel)`,
    );
  }
  return followRedirects(url, { follow });
}
