import { createHash, randomUUID } from "node:crypto";

export type StateCodec = "whole" | "json-delta" | "cdc";

export interface BlobVersion {
  readonly version: string;
  readonly key: string;
  readonly size: number;
  readonly objectKey: string;
  readonly sha256: string;
}

export interface StateRef {
  readonly kind: "inline" | "object";
  readonly bytesBase64?: string;
  readonly objectKey?: string;
  readonly sha256: string;
  readonly size: number;
}

export interface StateRoot {
  readonly schemaVersion: 1;
  readonly rootId: string;
  readonly historyObjectKey?: string;
  readonly gameId: string;
  readonly checkpointSeq: number;
  readonly codec: StateCodec;
  readonly stateRef: StateRef;
  readonly blobManifest: Readonly<Record<string, BlobVersion>>;
  /** Object key of the previous immutable root when history is retained. */
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

export interface ObjectStoreListEntry {
  readonly key: string;
  readonly size?: number;
  readonly updatedAt?: Date;
}

export interface StateObjectStore {
  get(key: string): Promise<{ readonly body: Uint8Array; readonly version: string } | undefined>;
  put(key: string, body: Uint8Array, options?: ConditionalPut): Promise<ObjectStorePutResult>;
  delete(key: string): Promise<void>;
  list?(prefix: string): Promise<readonly ObjectStoreListEntry[]>;
}

export interface StateStoreOptions {
  readonly inlineStateMaxBytes?: number;
  readonly retainCheckpoints?: number;
  readonly enableTimeTravel?: boolean;
  readonly now?: () => Date;
}

export interface MaterializedGameState {
  readonly gameId: string;
  readonly checkpointSeq: number;
  readonly state: Uint8Array;
  readonly blobs: ReadonlyMap<string, BlobVersion>;
  readonly root?: StateRoot;
  readonly rootVersion?: string;
  readonly rootObjectKey?: string;
}

export interface GameStateSessionOptions {
  readonly gameId: string;
  readonly bundleCompatTag?: string;
  readonly blobCompatTag?: string;
  readonly enableTimeTravel?: boolean;
  readonly retainCheckpoints?: number;
}

export interface StateCheckpoint {
  readonly checkpointSeq: number;
  readonly rootId: string;
  readonly rootObjectKey: string;
  readonly createdAt: string;
  readonly codec: StateCodec;
  readonly byteSize: number;
  readonly blobCompatTag?: string;
  readonly bundleCompatTag?: string;
}

export interface ReapOrphansResult {
  readonly scanned: number;
  readonly deleted: number;
  readonly skipped: boolean;
}

export class StateStore {
  private readonly inlineStateMaxBytes: number;
  private readonly retainCheckpoints: number;
  private readonly enableTimeTravel: boolean;
  private readonly now: () => Date;

  constructor(
    private readonly store: StateObjectStore,
    options: StateStoreOptions = {},
  ) {
    this.inlineStateMaxBytes = options.inlineStateMaxBytes ?? 128 * 1024;
    this.retainCheckpoints = options.retainCheckpoints ?? 0;
    this.enableTimeTravel = options.enableTimeTravel ?? false;
    this.now = options.now ?? (() => new Date());
  }

  async materialize(gameId: string): Promise<MaterializedGameState> {
    const rootObject = await this.store.get(rootKey(gameId));
    if (!rootObject) return emptyMaterialized(gameId);
    const root = decodeRoot(rootObject.body);
    if (root.gameId !== gameId) throw new Error(`root gameId mismatch: expected ${gameId}, got ${root.gameId}`);
    return this.materializeRoot(root, rootObject.version, root.historyObjectKey ?? rootKey(gameId));
  }

  async viewCheckpoint(gameId: string, checkpointSeq: number): Promise<MaterializedGameState | undefined> {
    const located = await this.findCheckpointRoot(gameId, checkpointSeq);
    if (!located) return undefined;
    return this.materializeRoot(located.root, located.version, located.objectKey);
  }

  async listCheckpoints(gameId: string, limit = 100): Promise<readonly StateCheckpoint[]> {
    const checkpoints: StateCheckpoint[] = [];
    let current = await this.readHeadRoot(gameId);
    while (current && checkpoints.length < limit) {
      checkpoints.push(checkpointView(current.root, current.objectKey));
      if (!current.root.parent) break;
      current = await this.readRootObject(current.root.parent);
    }
    return checkpoints;
  }

  async restoreCheckpoint(
    gameId: string,
    checkpointSeq: number,
    options: Pick<GameStateSessionOptions, "bundleCompatTag" | "blobCompatTag"> = {},
  ): Promise<StateRoot | undefined> {
    const head = await this.readHeadRoot(gameId);
    const target = await this.findCheckpointRoot(gameId, checkpointSeq);
    if (!head || !target) return undefined;
    const root = this.buildRoot({
      gameId,
      checkpointSeq: head.root.checkpointSeq + 1,
      stateRef: target.root.stateRef,
      blobManifest: target.root.blobManifest,
      parent: head.root.historyObjectKey ?? head.objectKey,
      bundleCompatTag: options.bundleCompatTag ?? head.root.bundleCompatTag,
      blobCompatTag: options.blobCompatTag ?? target.root.blobCompatTag,
    });
    const historyObjectKey = checkpointRootKey(gameId, root.checkpointSeq, root.rootId);
    const retainedRoot = { ...root, historyObjectKey };
    await this.store.put(historyObjectKey, encodeRoot(retainedRoot));
    await this.store.put(rootKey(gameId), encodeRoot(retainedRoot), { ifCurrentVersion: head.version });
    return retainedRoot;
  }

  async openSession(options: GameStateSessionOptions): Promise<GameStateSession> {
    const materialized = await this.materialize(options.gameId);
    return new GameStateSession(
      this.store,
      {
        inlineStateMaxBytes: this.inlineStateMaxBytes,
        retainCheckpoints: options.retainCheckpoints ?? this.retainCheckpoints,
        enableTimeTravel: options.enableTimeTravel ?? this.enableTimeTravel,
        now: this.now,
      },
      options,
      materialized,
    );
  }

  async reapOrphans(gameId: string, olderThan: Date): Promise<ReapOrphansResult> {
    if (!this.store.list) return { scanned: 0, deleted: 0, skipped: true };
    const referenced = new Set<string>([rootKey(gameId)]);
    for (const checkpoint of await this.listCheckpoints(gameId, Number.MAX_SAFE_INTEGER)) {
      referenced.add(checkpoint.rootObjectKey);
      const materialized = await this.viewCheckpoint(gameId, checkpoint.checkpointSeq);
      if (!materialized?.root) continue;
      referenced.add(materialized.root.stateRef.objectKey ?? "");
      for (const blob of Object.values(materialized.root.blobManifest)) referenced.add(blob.objectKey);
    }
    let scanned = 0;
    let deleted = 0;
    for (const entry of await this.store.list(gamePrefix(gameId))) {
      scanned += 1;
      if (referenced.has(entry.key)) continue;
      if (entry.updatedAt && entry.updatedAt > olderThan) continue;
      await this.store.delete(entry.key);
      deleted += 1;
    }
    return { scanned, deleted, skipped: false };
  }

  private async materializeRoot(
    root: StateRoot,
    rootVersion: string | undefined,
    rootObjectKeyValue: string,
  ): Promise<MaterializedGameState> {
    return {
      gameId: root.gameId,
      checkpointSeq: root.checkpointSeq,
      state: await this.readStateBytes(root),
      blobs: new Map(Object.entries(root.blobManifest)),
      root,
      rootVersion,
      rootObjectKey: rootObjectKeyValue,
    };
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

  private async readHeadRoot(gameId: string): Promise<LocatedRoot | undefined> {
    const head = await this.store.get(rootKey(gameId));
    if (!head) return undefined;
    return { root: decodeRoot(head.body), version: head.version, objectKey: rootKey(gameId) };
  }

  private async readRootObject(objectKey: string): Promise<LocatedRoot | undefined> {
    const object = await this.store.get(objectKey);
    if (!object) return undefined;
    return { root: decodeRoot(object.body), version: object.version, objectKey };
  }

  private async findCheckpointRoot(gameId: string, checkpointSeq: number): Promise<LocatedRoot | undefined> {
    let current = await this.readHeadRoot(gameId);
    while (current) {
      if (current.root.checkpointSeq === checkpointSeq) return current;
      if (!current.root.parent) break;
      current = await this.readRootObject(current.root.parent);
    }
    return undefined;
  }

  private buildRoot(input: {
    readonly gameId: string;
    readonly checkpointSeq: number;
    readonly stateRef: StateRef;
    readonly blobManifest: Readonly<Record<string, BlobVersion>>;
    readonly parent?: string;
    readonly bundleCompatTag?: string;
    readonly blobCompatTag?: string;
  }): StateRoot {
    return {
      schemaVersion: 1,
      rootId: randomUUID(),
      gameId: input.gameId,
      checkpointSeq: input.checkpointSeq,
      codec: "whole",
      stateRef: input.stateRef,
      blobManifest: input.blobManifest,
      parent: input.parent,
      createdAt: this.now().toISOString(),
      bundleCompatTag: input.bundleCompatTag,
      blobCompatTag: input.blobCompatTag,
    };
  }
}

interface LocatedRoot {
  readonly root: StateRoot;
  readonly version: string | undefined;
  readonly objectKey: string;
}

interface SessionStoreOptions {
  readonly inlineStateMaxBytes: number;
  readonly retainCheckpoints: number;
  readonly enableTimeTravel: boolean;
  readonly now: () => Date;
}

export class GameStateSession {
  private state: Uint8Array;
  private dirtyState = false;
  private readonly blobs = new Map<string, BlobVersion>();
  private dirtyBlobs = new Map<string, Uint8Array>();
  private deletedBlobs = new Set<string>();
  private dirtyBlobManifest = false;
  private checkpointSeq: number;
  private rootVersion?: string;
  private root?: StateRoot;
  private rootObjectKey?: string;
  private flushChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly store: StateObjectStore,
    private readonly storeOptions: SessionStoreOptions,
    private readonly options: GameStateSessionOptions,
    materialized: MaterializedGameState,
  ) {
    this.state = materialized.state;
    for (const [key, version] of materialized.blobs) this.blobs.set(key, version);
    this.checkpointSeq = materialized.checkpointSeq;
    this.rootVersion = materialized.rootVersion;
    this.root = materialized.root;
    this.rootObjectKey = materialized.rootObjectKey;
  }

  readState(): Uint8Array {
    return new Uint8Array(this.state);
  }

  writeState(bytes: Uint8Array): void {
    this.state = new Uint8Array(bytes);
    this.dirtyState = true;
  }

  async putBlob(key: string, bytes: Uint8Array): Promise<void> {
    this.dirtyBlobs.set(key, new Uint8Array(bytes));
    this.deletedBlobs.delete(key);
  }

  async getBlob(key: string): Promise<Uint8Array | undefined> {
    const dirty = this.dirtyBlobs.get(key);
    if (dirty) return new Uint8Array(dirty);
    if (this.deletedBlobs.has(key)) return undefined;
    const version = this.blobs.get(key);
    if (!version) return undefined;
    const object = await this.store.get(version.objectKey);
    return object ? new Uint8Array(object.body) : undefined;
  }

  async deleteBlob(key: string): Promise<void> {
    const hadPersistedBlob = this.blobs.has(key);
    this.blobs.delete(key);
    this.dirtyBlobs.delete(key);
    this.deletedBlobs.add(key);
    this.dirtyBlobManifest = this.dirtyBlobManifest || hadPersistedBlob;
  }

  async listBlobs(prefix = ""): Promise<readonly string[]> {
    const keys = new Set([...this.blobs.keys(), ...this.dirtyBlobs.keys()]);
    for (const key of this.deletedBlobs) keys.delete(key);
    return [...keys].filter((key) => key.startsWith(prefix)).sort();
  }

  async flush(): Promise<StateRoot | undefined> {
    const run = this.flushChain.then(() => this.flushExclusive());
    this.flushChain = run.then(() => undefined, () => undefined);
    return await run;
  }

  private async flushExclusive(): Promise<StateRoot | undefined> {
    if (!this.isDirty()) return undefined;
    const previousRoot = this.root;
    const blobManifest = await this.writeDirtyBlobs();
    const stateRef = await this.writeStateRef();
    const root = this.buildRoot(stateRef, blobManifest);
    const historyObjectKey = this.shouldRetainHistory()
      ? checkpointRootKey(this.options.gameId, root.checkpointSeq, root.rootId)
      : undefined;
    const committedRoot = historyObjectKey ? { ...root, historyObjectKey } : root;

    if (historyObjectKey) await this.store.put(historyObjectKey, encodeRoot(committedRoot));
    const put = await this.store.put(rootKey(this.options.gameId), encodeRoot(committedRoot), {
      ifCurrentVersion: this.rootVersion,
    });

    this.checkpointSeq = committedRoot.checkpointSeq;
    this.rootVersion = put.version;
    this.root = committedRoot;
    this.rootObjectKey = historyObjectKey ?? rootKey(this.options.gameId);
    this.blobs.clear();
    for (const [key, version] of Object.entries(committedRoot.blobManifest)) this.blobs.set(key, version);
    this.dirtyBlobs.clear();
    this.deletedBlobs.clear();
    this.dirtyBlobManifest = false;
    this.dirtyState = false;
    if (!this.shouldRetainHistory()) await this.deleteSupersededObjects(previousRoot, committedRoot);
    await this.pruneRetainedCheckpoints();
    return committedRoot;
  }

  private isDirty(): boolean {
    return this.dirtyState || this.dirtyBlobs.size > 0 || this.dirtyBlobManifest;
  }

  private async writeDirtyBlobs(): Promise<Readonly<Record<string, BlobVersion>>> {
    const blobManifest = new Map(this.blobs);
    for (const key of this.deletedBlobs) blobManifest.delete(key);
    for (const [key, bytes] of this.dirtyBlobs) {
      const hash = sha256(bytes);
      const objectKey = blobKey(this.options.gameId, key, hash);
      await this.store.put(objectKey, bytes);
      blobManifest.set(key, {
        version: randomUUID(),
        key,
        size: bytes.byteLength,
        objectKey,
        sha256: hash,
      });
    }
    return Object.fromEntries([...blobManifest.entries()].sort(([left], [right]) => left.localeCompare(right)));
  }

  private async writeStateRef(): Promise<StateRef> {
    if (this.state.byteLength <= this.storeOptions.inlineStateMaxBytes) return inlineStateRef(this.state);
    const hash = sha256(this.state);
    const objectKey = stateObjectKey(this.options.gameId, hash);
    await this.store.put(objectKey, this.state);
    return objectStateRef(objectKey, this.state, hash);
  }

  private buildRoot(stateRef: StateRef, blobManifest: Readonly<Record<string, BlobVersion>>): StateRoot {
    return {
      schemaVersion: 1,
      rootId: randomUUID(),
      gameId: this.options.gameId,
      checkpointSeq: this.checkpointSeq + 1,
      codec: "whole",
      stateRef,
      blobManifest,
      parent: this.shouldRetainHistory() ? this.root?.historyObjectKey ?? this.rootObjectKey : undefined,
      createdAt: this.storeOptions.now().toISOString(),
      bundleCompatTag: this.options.bundleCompatTag,
      blobCompatTag: this.options.blobCompatTag,
    };
  }

  private shouldRetainHistory(): boolean {
    return this.storeOptions.enableTimeTravel || this.storeOptions.retainCheckpoints > 0;
  }

  private async deleteSupersededObjects(previousRoot: StateRoot | undefined, currentRoot: StateRoot): Promise<void> {
    if (!previousRoot) return;
    const retained = referencedObjects(currentRoot);
    for (const objectKey of referencedObjects(previousRoot)) {
      if (!retained.has(objectKey)) await this.store.delete(objectKey);
    }
  }

  private async pruneRetainedCheckpoints(): Promise<void> {
    if (this.storeOptions.enableTimeTravel || this.storeOptions.retainCheckpoints <= 0 || !this.root) return;
    const protectedObjects = new Set<string>([rootKey(this.options.gameId)]);
    const prune: { readonly root: StateRoot; readonly objectKey: string }[] = [];
    let root: StateRoot | undefined = this.root;
    let objectKey: string | undefined = root.historyObjectKey;
    let index = 0;
    while (root && objectKey) {
      if (index < this.storeOptions.retainCheckpoints) {
        protectedObjects.add(objectKey);
        for (const key of referencedObjects(root)) protectedObjects.add(key);
      } else {
        prune.push({ root, objectKey });
      }
      if (!root.parent) break;
      objectKey = root.parent;
      const parent = await this.store.get(root.parent);
      root = parent ? decodeRoot(parent.body) : undefined;
      index += 1;
    }
    for (const item of prune) {
      if (!protectedObjects.has(item.objectKey)) await this.store.delete(item.objectKey);
      for (const key of referencedObjects(item.root)) {
        if (!protectedObjects.has(key)) await this.store.delete(key);
      }
    }
  }
}

export class CheckpointScheduler {
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly intervalMs: number) {}

  schedule(gameId: string, session: GameStateSession): void {
    this.cancel(gameId);
    const timer = setTimeout(() => {
      this.timers.delete(gameId);
      void session.flush();
    }, this.intervalMs);
    timer.unref();
    this.timers.set(gameId, timer);
  }

  async flushNow(gameId: string, session: GameStateSession): Promise<StateRoot | undefined> {
    this.cancel(gameId);
    return session.flush();
  }

  cancel(gameId: string): void {
    const timer = this.timers.get(gameId);
    if (!timer) return;
    clearTimeout(timer);
    this.timers.delete(gameId);
  }

  stop(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}

export function rootKey(gameId: string): string {
  return `${gamePrefix(gameId)}root.json`;
}

export function checkpointRootKey(gameId: string, checkpointSeq: number, rootId: string): string {
  return `${gamePrefix(gameId)}roots/${checkpointSeq.toString().padStart(20, "0")}-${rootId}.json`;
}

function gamePrefix(gameId: string): string {
  return `state/${encodeURIComponent(gameId)}/`;
}

function blobKey(gameId: string, key: string, hash: string): string {
  return `${gamePrefix(gameId)}blob/${encodeURIComponent(key)}/${hash}`;
}

function stateObjectKey(gameId: string, hash: string): string {
  return `${gamePrefix(gameId)}objects/state/${hash}`;
}

function inlineStateRef(bytes: Uint8Array): StateRef {
  return {
    kind: "inline",
    bytesBase64: Buffer.from(bytes).toString("base64"),
    sha256: sha256(bytes),
    size: bytes.byteLength,
  };
}

function objectStateRef(objectKey: string, bytes: Uint8Array, hash: string): StateRef {
  return {
    kind: "object",
    objectKey,
    sha256: hash,
    size: bytes.byteLength,
  };
}

function encodeRoot(root: StateRoot): Uint8Array {
  return Buffer.from(`${JSON.stringify(root)}\n`, "utf8");
}

function decodeRoot(bytes: Uint8Array): StateRoot {
  const parsed = JSON.parse(Buffer.from(bytes).toString("utf8")) as StateRoot;
  if (parsed.schemaVersion !== 1) throw new Error("unsupported state root schema version");
  return {
    ...parsed,
    rootId: parsed.rootId ?? randomUUID(),
    historyObjectKey: parsed.historyObjectKey,
    blobManifest: parsed.blobManifest ?? {},
  };
}

function emptyMaterialized(gameId: string): MaterializedGameState {
  return {
    gameId,
    checkpointSeq: 0,
    state: new Uint8Array(),
    blobs: new Map(),
  };
}

function checkpointView(root: StateRoot, rootObjectKey: string): StateCheckpoint {
  return {
    checkpointSeq: root.checkpointSeq,
    rootId: root.rootId,
    rootObjectKey,
    createdAt: root.createdAt,
    codec: root.codec,
    byteSize: root.stateRef.size,
    blobCompatTag: root.blobCompatTag,
    bundleCompatTag: root.bundleCompatTag,
  };
}

function referencedObjects(root: StateRoot): Set<string> {
  const keys = new Set<string>();
  if (root.stateRef.objectKey) keys.add(root.stateRef.objectKey);
  for (const blob of Object.values(root.blobManifest)) keys.add(blob.objectKey);
  return keys;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export * from "./adapters.mjs";
