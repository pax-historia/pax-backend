import { mkdir, readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { build } from "esbuild";

import { extractManifestFromBundleSource } from "../manifest.mjs";
import type { BundleBuildInput, BundleBuildResult } from "../types.mjs";

export async function buildBundle(input: BundleBuildInput): Promise<BundleBuildResult> {
  const packageDir = resolve(input.packageDir);
  const entry = resolve(packageDir, input.entry ?? "src/index.mts");
  const outFile = resolve(packageDir, input.outFile ?? "dist/bundle.js");
  await mkdir(dirname(outFile), { recursive: true });
  await build({
    entryPoints: [entry],
    bundle: true,
    format: "iife",
    target: "es2022",
    platform: "neutral",
    globalName: "__pax_bundle_module",
    footer: { js: "__pax_install(__pax_bundle_module.default);" },
    outfile: outFile,
  });
  const source = await readFile(outFile, "utf8");
  const manifest = extractManifestFromBundleSource(source);
  const info = await stat(outFile);
  return {
    packageDir,
    entry,
    outFile,
    manifest,
    bytes: info.size,
  };
}
