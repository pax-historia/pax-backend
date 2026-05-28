#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export async function runCli(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;
  try {
    if (command === "build") {
      const { buildBundle } = await import("./commands/build.mjs");
      const packageDir = requiredArg(rest, 0, "package directory");
      const result = await buildBundle({ packageDir });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return 0;
    }

    if (command === "verify") {
      const { verifyBundle } = await import("./commands/verify.mjs");
      const path = requiredArg(rest, 0, "bundle path");
      const result = await verifyBundle(resolve(path));
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return 0;
    }

    if (command === "publish") {
      const { publishBundle } = await import("./commands/publish.mjs");
      const { extractManifestFromBundleSource } = await import("./manifest.mjs");
      const packageDir = requiredArg(rest, 0, "package directory");
      const controlPlaneUrl = requiredFlag(rest, "--control-plane-url");
      const bundleName = requiredFlag(rest, "--bundle-name");
      const bundlePath = resolve(packageDir, "dist/bundle.js");
      const source = await readFile(bundlePath, "utf8");
      const manifest = extractManifestFromBundleSource(source);
      const result = await publishBundle({
        controlPlaneUrl,
        bundleName,
        manifest,
        source,
      });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return result.ok ? 0 : 1;
    }

    throw new Error("usage: pax-bundle <build|verify|publish> ...");
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

function requiredArg(args: readonly string[], index: number, label: string): string {
  const value = args[index];
  if (!value || value.startsWith("--")) throw new Error(`missing ${label}`);
  return value;
}

function requiredFlag(args: readonly string[], flag: string): string {
  const index = args.indexOf(flag);
  if (index < 0) throw new Error(`missing ${flag}`);
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`missing value for ${flag}`);
  return value;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = await runCli(process.argv.slice(2));
}
