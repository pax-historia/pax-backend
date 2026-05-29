import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

import type {
  ConditionalPut,
  ObjectStoreListEntry,
  ObjectStorePutResult,
  StateObjectStore,
} from "./index.mjs";

export class ConditionalPutConflict extends Error {
  constructor(readonly key: string) {
    super(`conditional put conflict for ${key}`);
  }
}

export class MemoryStateObjectStore implements StateObjectStore {
  private readonly objects = new Map<string, { readonly body: Uint8Array; readonly version: string; readonly updatedAt: Date }>();

  async get(key: string): Promise<{ readonly body: Uint8Array; readonly version: string } | undefined> {
    const object = this.objects.get(key);
    return object ? { body: new Uint8Array(object.body), version: object.version } : undefined;
  }

  async put(key: string, body: Uint8Array, options: ConditionalPut = {}): Promise<ObjectStorePutResult> {
    const existing = this.objects.get(key);
    if (options.ifCurrentVersion !== undefined && existing?.version !== options.ifCurrentVersion) {
      throw new ConditionalPutConflict(key);
    }
    const version = etag(body);
    this.objects.set(key, { body: new Uint8Array(body), version, updatedAt: new Date() });
    return { version };
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async list(prefix: string): Promise<readonly ObjectStoreListEntry[]> {
    return [...this.objects.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, object]) => ({ key, size: object.body.byteLength, updatedAt: object.updatedAt }))
      .sort((left, right) => left.key.localeCompare(right.key));
  }
}

export class LocalStateObjectStore implements StateObjectStore {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  async get(key: string): Promise<{ readonly body: Uint8Array; readonly version: string } | undefined> {
    try {
      const body = await readFile(this.pathFor(key));
      return { body, version: etag(body) };
    } catch (err) {
      if (isErrnoException(err) && err.code === "ENOENT") return undefined;
      throw err;
    }
  }

  async put(key: string, body: Uint8Array, options: ConditionalPut = {}): Promise<ObjectStorePutResult> {
    const existing = await this.get(key);
    if (options.ifCurrentVersion !== undefined && existing?.version !== options.ifCurrentVersion) {
      throw new ConditionalPutConflict(key);
    }
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
    return { version: etag(body) };
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }

  async list(prefix: string): Promise<readonly ObjectStoreListEntry[]> {
    const entries: ObjectStoreListEntry[] = [];
    await walk(this.root, async (path) => {
      const key = relative(this.root, path).split(sep).join("/");
      if (!key.startsWith(prefix)) return;
      const info = await stat(path);
      entries.push({ key, size: info.size, updatedAt: info.mtime });
    });
    return entries.sort((left, right) => left.key.localeCompare(right.key));
  }

  private pathFor(key: string): string {
    const resolved = resolve(this.root, key);
    if (resolved !== this.root && !resolved.startsWith(`${this.root}${sep}`)) {
      throw new Error(`state object key escapes local root: ${key}`);
    }
    return resolved;
  }
}

export interface S3StateObjectStoreConfig {
  readonly bucket: string;
  readonly prefix?: string;
  readonly region?: string;
  readonly endpoint?: string;
  readonly forcePathStyle?: boolean;
}

export class S3StateObjectStore implements StateObjectStore {
  private readonly client: S3Client;
  private readonly prefix: string;

  constructor(private readonly config: S3StateObjectStoreConfig) {
    this.client = new S3Client({
      region: config.region ?? "auto",
      endpoint: config.endpoint,
      forcePathStyle: config.forcePathStyle ?? config.endpoint !== undefined,
    });
    this.prefix = config.prefix?.replace(/^\/+|\/+$/g, "") ?? "";
  }

  async get(key: string): Promise<{ readonly body: Uint8Array; readonly version: string } | undefined> {
    try {
      const result = await this.client.send(
        new GetObjectCommand({ Bucket: this.config.bucket, Key: this.keyFor(key) }),
      );
      if (!result.Body) return { body: new Uint8Array(), version: result.ETag ?? "" };
      const body = await responseBodyToBytes(result.Body);
      return { body, version: result.ETag ?? etag(body) };
    } catch (err) {
      if (isObjectNotFound(err)) return undefined;
      throw err;
    }
  }

  async put(key: string, body: Uint8Array, options: ConditionalPut = {}): Promise<ObjectStorePutResult> {
    try {
      const result = await this.client.send(
        new PutObjectCommand({
          Bucket: this.config.bucket,
          Key: this.keyFor(key),
          Body: Buffer.from(body),
          IfMatch: options.ifCurrentVersion,
        }),
      );
      return { version: result.ETag ?? result.VersionId ?? etag(body) };
    } catch (err) {
      if (isConditionalConflict(err)) throw new ConditionalPutConflict(key);
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.config.bucket, Key: this.keyFor(key) }));
  }

  async list(prefix: string): Promise<readonly ObjectStoreListEntry[]> {
    const entries: ObjectStoreListEntry[] = [];
    let ContinuationToken: string | undefined;
    do {
      const result = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.config.bucket,
          Prefix: this.keyFor(prefix),
          ContinuationToken,
        }),
      );
      for (const object of result.Contents ?? []) {
        if (!object.Key) continue;
        entries.push({
          key: this.unkey(object.Key),
          size: object.Size,
          updatedAt: object.LastModified,
        });
      }
      ContinuationToken = result.NextContinuationToken;
    } while (ContinuationToken);
    return entries.sort((left, right) => left.key.localeCompare(right.key));
  }

  private keyFor(key: string): string {
    return this.prefix ? `${this.prefix}/${key}` : key;
  }

  private unkey(key: string): string {
    return this.prefix && key.startsWith(`${this.prefix}/`) ? key.slice(this.prefix.length + 1) : key;
  }
}

function etag(body: Uint8Array): string {
  return createHash("sha256").update(body).digest("hex");
}

async function walk(root: string, visit: (path: string) => Promise<void>): Promise<void> {
  let entries: readonly import("node:fs").Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (err) {
    if (isErrnoException(err) && err.code === "ENOENT") return;
    throw err;
  }
  await Promise.all(
    entries.map(async (entry) => {
      const path = join(root, entry.name);
      if (entry.isDirectory()) {
        await walk(path, visit);
      } else if (entry.isFile()) {
        await visit(path);
      }
    }),
  );
}

async function responseBodyToBytes(body: unknown): Promise<Uint8Array> {
  if (body && typeof body === "object" && "transformToByteArray" in body) {
    return (body as { transformToByteArray: () => Promise<Uint8Array> }).transformToByteArray();
  }
  if (body instanceof Uint8Array) return body;
  if (typeof body === "string") return Buffer.from(body);
  if (body && typeof body === "object" && Symbol.asyncIterator in body) {
    const chunks: Buffer[] = [];
    for await (const chunk of body as AsyncIterable<Uint8Array | string>) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
  throw new Error("Tigris object body is not readable");
}

function isObjectNotFound(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const candidate = err as { readonly name?: unknown; readonly $metadata?: unknown };
  const metadata = candidate.$metadata;
  const statusCode =
    metadata && typeof metadata === "object"
      ? (metadata as { readonly httpStatusCode?: unknown }).httpStatusCode
      : undefined;
  return candidate.name === "NoSuchKey" || statusCode === 404;
}

function isConditionalConflict(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const candidate = err as { readonly name?: unknown; readonly $metadata?: unknown };
  const metadata = candidate.$metadata;
  const statusCode =
    metadata && typeof metadata === "object"
      ? (metadata as { readonly httpStatusCode?: unknown }).httpStatusCode
      : undefined;
  return candidate.name === "PreconditionFailed" || statusCode === 409 || statusCode === 412;
}

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return !!err && typeof err === "object" && "code" in err;
}
