import type { BundlePublishInput, BundlePublishResult } from "../types.mjs";

export async function publishBundle(input: BundlePublishInput): Promise<BundlePublishResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const url = new URL(
    `/admin/bundles/${encodeURIComponent(input.bundleName)}`,
    input.controlPlaneUrl,
  );
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      manifest: input.manifest,
      source: input.source,
    }),
  });
  const raw = await res.text();
  return {
    ok: res.ok,
    statusCode: res.status,
    body: parseJson(raw),
  };
}

function parseJson(raw: string): unknown {
  try {
    return raw.length > 0 ? JSON.parse(raw) : {};
  } catch {
    return raw;
  }
}
