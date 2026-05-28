import type { ReferenceServiceResult, ReferenceUrlService } from "../types.mjs";
import { badRequest, isAllowedHttpFetchTarget, isRecord, ok, stringifyHeaders } from "../util.mjs";

export const httpFetchService: ReferenceUrlService = {
  kindName: "http.fetch.v1",
  pathname: "/_url-services/http-fetch/invoke",
  purpose: "Perform allowlisted outbound HTTP and return status, headers, and text body.",

  async handle(request, config) {
    return httpFetch(request.args, config.httpFetchAllowlist);
  },
};

async function httpFetch(
  args: unknown,
  allowlist: readonly string[],
): Promise<ReferenceServiceResult> {
  if (!isRecord(args) || typeof args["url"] !== "string") {
    return badRequest("http.fetch.v1 requires args.url");
  }
  let url: URL;
  try {
    url = new URL(args["url"]);
  } catch {
    return badRequest("http.fetch.v1 args.url must be an absolute URL");
  }
  if (!isAllowedHttpFetchTarget(url, allowlist)) {
    return {
      handled: true,
      statusCode: 403,
      body: {
        error: "targetNotAllowed",
        detail: { url: url.toString(), allowlist },
      },
    };
  }

  const method = typeof args["method"] === "string" ? args["method"].toUpperCase() : "GET";
  const headers = isRecord(args["headers"]) ? stringifyHeaders(args["headers"]) : undefined;
  const body =
    method === "GET" || method === "HEAD"
      ? undefined
      : typeof args["body"] === "string"
        ? args["body"]
        : args["body"] === undefined
          ? undefined
          : JSON.stringify(args["body"]);

  const response = await fetch(url, { method, headers, body });
  return ok({
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    body: await response.text(),
  });
}
