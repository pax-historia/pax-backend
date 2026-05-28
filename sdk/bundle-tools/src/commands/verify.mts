import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";

import { lintBundleSource } from "@pax-backend/runtime-sdk-test-harness";

import { extractManifestFromBundleSource } from "../manifest.mjs";
import type { BundleVerifyResult } from "../types.mjs";

export async function verifyBundle(path: string): Promise<BundleVerifyResult> {
  const [buffer, info] = await Promise.all([readFile(path), stat(path)]);
  const source = buffer.toString("utf8");
  const lintFindings = lintBundleSource(source);
  return {
    path,
    sha256: createHash("sha256").update(buffer).digest("hex"),
    bytes: info.size,
    manifest: extractManifestFromBundleSource(source),
    deterministic: lintFindings.length === 0,
    lintFindings,
  };
}
