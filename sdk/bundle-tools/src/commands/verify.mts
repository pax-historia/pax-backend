import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";

import type { BundleVerifyResult } from "../types.mjs";

export async function verifyBundle(path: string): Promise<BundleVerifyResult> {
  const [bytes, info] = await Promise.all([readFile(path), stat(path)]);
  return {
    path,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: info.size,
  };
}
