import type { BundleManifest } from "@pax-backend/runtime-sdk";
import type { HarnessLintFinding } from "@pax-backend/runtime-sdk-test-harness";

export interface BundleBuildInput {
  readonly packageDir: string;
  readonly entry?: string;
  readonly outFile?: string;
}

export interface BundleBuildResult {
  readonly packageDir: string;
  readonly entry: string;
  readonly outFile: string;
  readonly manifest: BundleManifest;
  readonly bytes: number;
}

export interface BundlePublishInput {
  readonly controlPlaneUrl: string;
  readonly bundleName: string;
  readonly manifest: BundleManifest;
  readonly source: string;
  readonly fetchImpl?: typeof fetch;
}

export interface BundlePublishResult {
  readonly ok: boolean;
  readonly statusCode: number;
  readonly body: unknown;
}

export interface BundleVerifyResult {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly manifest: BundleManifest;
  readonly deterministic: boolean;
  readonly lintFindings: readonly HarnessLintFinding[];
}
