import { createHash, randomUUID } from "node:crypto";

export type StateCodec = "whole" | "json-delta" | "cdc";

export interface BlobVersion {
  readonly version: string;
  readonly key: string;
  readonly size: number;
  readonly objectKey: string;
  readonly sha256: string;
}

export interface StateRoot {
  readonly schemaVersion: 1;
  readonly gameId: string;
  readonly checkpointSeq: number;
  readonly codec: StateCodec;
  readonly stateRef: {
    readonly kind: "inline" | "object";
    readonly bytesBase64?: string;
    readonly objectKey?: string;
    readonly sha256: string;
    readonly size: number;
  };
  readonly blobManifest: Readonly<Record<string, BlobVersion>>;
  readonly parent?: string;
  readonly createdAt: string;
  readonly bundleCompatTag?: string;
  readonly blobCompatTag?: string;
}

export interface ConditionalPut {
  readonly ifCurrentVersion?: string;
}

export interface ObjectStorePutResult {
  readonly version: string;
}

export interface StateObjectStore {
  get(key: string): Promise<{ readonly body: Uint8Array; readonly version: string } | undefined>;
  put(key: string, body: Uint8Array, options?: ConditionalPut): Promise<ObjectStorePutResult>;
  delete(key: string): Promise<void>;
}

export interface MaterializedGameState {
  readonly gameId: string;
  readonly checkpointSeq: number;
  readonly state: Uint8Array;
  readonly blobs: ReadonlyMap<string, BlobVersion>;
  readonly rootVersion?: string;
}

export interface GameStateSessionOptions {
  readonly gameId: string;
  readonly bundleCompatTag?: string;
  readonly blobCompatTag?: string;
  readonly enableTimeTravel?: boolean;
}

export class StateStore {
  constructor(
    private readonly store: StateObjectStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async materialize(gameId: string): Promise<MaterializedGameState> {
    const rootObject = await this.store.get(rootKey(gameId));
    if (!rootObject) {
      return {
        gameId,
        checkpointSeq: 0,
        state: new Uint8Array(),
        blobs: new Map(),
      };
    }
    const root = decodeRoot(rootObject.body);
    return {
      gameId,
      checkpointSeq: root.checkpointSeq,
      state: await this.readStateBytes(root),
      blobs: new Map(Object.entries(root.blobManifest)),
      rootVersion: rootObject.version,
    };
  }

  async openSession(options: GameStateSessionOptions): Promise<GameStateSession> {
    const materialized = await this.materialize(options.gameId);
    return new GameStateSession(this.store, this.now, options, materialized);
  }

  private async readStateBytes(root: StateRoot): Promise<Uint8Array> {
    if (root.stateRef.kind === "inline") {
      return Buffer.from(root.stateRef.bytesBase64 ?? "", "base64");
    }
    if (!root.stateRef.objectKey) throw new Error(`root ${root.gameId} missing state object key`);
    const object = await this.store.get(root.stateRef.objectKey);
    if (!object) throw new Error(`state object missing: ${root.stateRef.objectKey}`);
    return object.body;
  }
}

export class GameStateSession {
  private state: Uint8Array;
  private dirtyState = false;
  private readonly blobs = new Map<string, BlobVersion>();
  private dirtyBlobs = new Map<string, Uint8Array>();
  private dirtyBlobManifest = false;

  constructor(
    private readonly store: StateObjectStore,
    private readonly now: () => Date,
    private readonly options: GameStateSessionOptions,
    materialized: MaterializedGameState,
  ) {
    this.state = materialized.state;
    for (const [key, version] of materialized.blobs) this.blobs.set(key, version);
    this.checkpointSeq = materialized.checkpointSeq;
    this.rootVersion = materialized.rootVersion;
  }

  private checkpointSeq: number;
  private rootVersion?: string;

  readState(): Uint8Array {
    return new Uint8Array(this.state);
  }

  writeState(bytes: Uint8Array): void {
    this.state = new Uint8Array(bytes);
    this.dirtyState = true;
  }

  async putBlob(key: string, bytes: Uint8Array): Promise<void> {
    this.dirtyBlobs.set(key, new Uint8Array(bytes));
  }

  async getBlob(key: string): Promise<Uint8Array | undefined> {
    const dirty = this.dirtyBlobs.get(key);
    if (dirty) return new Uint8Array(dirty);
    const version = this.blobs.get(key);
    if (!version) return undefined;
    const object = await this.store.get(version.objectKey);
    return object ? new Uint8Array(object.body) : undefined;
  }

  async deleteBlob(key: string): Promise<void> {
    const hadPersistedBlob = this.blobs.delete(key);
    this.dirtyBlobs.delete(key);
    this.dirtyBlobManifest = this.dirtyBlobManifest || hadPersistedBlob;
  }

  async listBlobs(prefix = ""): Promise<readonly string[]> {
    const keys = new Set([...this.blobs.keys(), ...this.dirtyBlobs.keys()]);
    return [...keys].filter((key) => key.startsWith(prefix)).sort();
  }

  async flush(): Promise<StateRoot | undefined> {
    if (!this.dirtyState && this.dirtyBlobs.size === 0 && !this.dirtyBlobManifest) return undefined;

    const blobManifest = new Map(this.blobs);
    for (const [key, bytes] of this.dirtyBlobs) {
      const objectKey = blobKey(this.options.gameId, key, sha256(bytes));
      await this.store.put(objectKey, bytes);
      blobManifest.set(key, {
        version: randomUUID(),
        key,
        size: bytes.byteLength,
        objectKey,
        sha256: sha256(bytes),
      });
    }

    const root: StateRoot = {
      schemaVersion: 1,
      gameId: this.options.gameId,
      checkpointSeq: this.checkpointSeq + 1,
      codec: "whole",
      stateRef: inlineStateRef(this.state),
      blobManifest: Object.fromEntries([...blobManifest.entries()].sort(([left], [right]) => left.localeCompare(right))),
      parent: this.options.enableTimeTravel ? this.rootVersion : undefined,
      createdAt: this.now().toISOString(),
      bundleCompatTag: this.options.bundleCompatTag,
      blobCompatTag: this.options.blobCompatTag,
    };
    const put = await this.store.put(rootKey(this.options.gameId), encodeRoot(root), {
      ifCurrentVersion: this.rootVersion,
    });
    this.checkpointSeq = root.checkpointSeq;
    this.rootVersion = put.version;
    this.blobs.clear();
    for (const [key, version] of blobManifest) this.blobs.set(key, version);
    this.dirtyBlobs.clear();
    this.dirtyBlobManifest = false;
    this.dirtyState = false;
    return root;
  }
}

export function rootKey(gameId: string): string {
  return `state/${encodeURIComponent(gameId)}.root.json`;
}

function blobKey(gameId: string, key: string, hash: string): string {
  return `state/${encodeURIComponent(gameId)}/blob/${encodeURIComponent(key)}/${hash}`;
}

function inlineStateRef(bytes: Uint8Array): StateRoot["stateRef"] {
  return {
    kind: "inline",
    bytesBase64: Buffer.from(bytes).toString("base64"),
    sha256: sha256(bytes),
    size: bytes.byteLength,
  };
}

function encodeRoot(root: StateRoot): Uint8Array {
  return Buffer.from(`${JSON.stringify(root)}\n`, "utf8");
}

function decodeRoot(bytes: Uint8Array): StateRoot {
  const parsed = JSON.parse(Buffer.from(bytes).toString("utf8")) as StateRoot;
  if (parsed.schemaVersion !== 1) throw new Error("unsupported state root schema version");
  return parsed;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
