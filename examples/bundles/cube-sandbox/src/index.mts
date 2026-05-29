// cube-sandbox — server-authoritative Rapier physics on the substrate.
//
// The whole physics world lives inside the isolate. Rapier (Rust -> WASM) is
// compiled in `onWake`; the substrate drives a fixed-step loop via the new
// `onTick` hook (the bundle opts in with `c.lifecycle.requestTick`). Every tick
// the world steps once and the authoritative transforms are broadcast to every
// connected player. Players throw cubes by sending impulses. One game == one
// room == one isolate, so this is a pure Broker WebSocket fan-out workload.

import RAPIER from "@dimforge/rapier3d-compat";

import { defineBundle, type SubstrateContext } from "@pax-backend/runtime-sdk";

// The package's star re-exports aren't visible as named type imports under
// NodeNext, but the default export is the full namespace, so derive instance
// types from the class constructors on it.
type World = InstanceType<typeof RAPIER.World>;
type RigidBody = InstanceType<typeof RAPIER.RigidBody>;

const GRAVITY = { x: 0, y: -9.81, z: 0 };
const GROUND_HALF = 14; // half-extent of the square floor
const WALL_H = 8; // wall height
const CUBE_HALF = 0.5; // half-size of each cube
const CUBE_COUNT = 60; // fixed pool — keeps broadcast size bounded
const TICK_MS = 33; // ~30 Hz
const MAX_IMPULSE = 45; // clamp so one throw can't fling a cube to infinity
const PERSIST_EVERY_TICKS = 150; // ~5 s between durable checkpoints of positions
const FULL_SNAPSHOT_EVERY_TICKS = 30; // keep delta-only clients bounded to <=1s stale

const PALETTE = [
  "#ef4444", "#f59e0b", "#22c55e", "#3b82f6",
  "#a855f7", "#ec4899", "#14b8a6", "#eab308",
];

interface Vec3 {
  x: number;
  y: number;
  z: number;
}

interface CubeRec {
  readonly id: number;
  readonly body: RigidBody;
  readonly color: string;
}

interface SavedCube {
  readonly id: number;
  readonly color: string;
  readonly p: readonly [number, number, number];
  readonly q: readonly [number, number, number, number];
}

let rapierReady = false;
let world: World | null = null;
let cubes: CubeRec[] = [];
const byId = new Map<number, CubeRec>();
const lastSentRows = new Map<number, string>();
let ticksSincePersist = 0;
const playerColors = new Map<string, string>();

export default defineBundle({
  manifest: {
    compatTagProduced: "cubes:v1",
    compatTagsAccepted: ["cubes:v1"],
    runtimeContractRequired: 1,
  },

  async onWake(c, payload) {
    if (!rapierReady) {
      await RAPIER.init();
      rapierReady = true;
    }
    const saved = readSaved((await c.state.read()) ?? payload.state);
    buildWorld(saved);
    // Re-arm the server loop on every wake; ticking stops when the game sleeps.
    c.lifecycle.requestTick(TICK_MS);
    c.log.emit({ event: "cubes.onWake", reason: payload.reason, cubes: cubes.length });
  },

  onPlayerConnect(c, payload) {
    const color = assignColor(c, payload.playerId);
    c.ws.send(payload.playerId, {
      type: "init",
      you: { playerId: payload.playerId, color },
      world: { half: GROUND_HALF, cube: CUBE_HALF, wallH: WALL_H },
      bodies: cubes.map((cube) => ({ id: cube.id, color: cube.color })),
    });
    broadcastInfo(c);
  },

  onPlayerDisconnect(c, payload) {
    playerColors.delete(payload.playerId);
    broadcastInfo(c);
  },

  onPlayerMessage(c, payload) {
    if (!world) return;
    const body = isRecord(payload.body) ? payload.body : {};
    const type = typeof body["type"] === "string" ? body["type"] : "";
    if (type === "throw") {
      const cube = byId.get(numberOr(body["id"], -1));
      if (!cube) return;
      const impulse = clampVec(asVec(body["impulse"]) ?? randomPop(c), MAX_IMPULSE);
      cube.body.applyImpulse(impulse, true);
      return;
    }
    if (type === "shove") {
      // Pop every cube — a fun "stir the pot" button.
      for (const cube of cubes) {
        cube.body.applyImpulse(randomPop(c), true);
      }
      return;
    }
    if (type === "reset") {
      buildWorld(null);
      void persist(c);
    }
  },

  async onTick(c, payload) {
    if (!world) return;
    world.step();
    const full = payload.tickSeq % FULL_SNAPSHOT_EVERY_TICKS === 0;
    const b: number[][] = [];
    for (let i = 0; i < cubes.length; i += 1) {
      const cube = cubes[i]!;
      const t = cube.body.translation();
      const r = cube.body.rotation();
      const row = [
        cube.id,
        round(t.x, 2), round(t.y, 2), round(t.z, 2),
        round(r.x, 3), round(r.y, 3), round(r.z, 3), round(r.w, 3),
      ];
      const rowKey = row.join(",");
      if (full || lastSentRows.get(cube.id) !== rowKey) {
        b.push(row);
        lastSentRows.set(cube.id, rowKey);
      }
    }
    if (full || b.length > 0) {
      await c.ws.send("all", { type: "s", t: payload.tickSeq, full: full ? 1 : 0, b });
    }

    ticksSincePersist += 1;
    if (ticksSincePersist >= PERSIST_EVERY_TICKS) {
      ticksSincePersist = 0;
      await persist(c);
    }
  },

  async onSleep(c, payload) {
    await persist(c);
    await c.state.flush();
    c.log.emit({ event: "cubes.onSleep", reason: payload.reason });
  },
});

function buildWorld(saved: readonly SavedCube[] | null): void {
  if (world) {
    world.free();
    world = null;
  }
  cubes = [];
  byId.clear();
  lastSentRows.clear();

  const w = new RAPIER.World(GRAVITY);
  w.timestep = TICK_MS / 1000;

  // Floor.
  const ground = w.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  w.createCollider(
    RAPIER.ColliderDesc.cuboid(GROUND_HALF, 0.5, GROUND_HALF).setTranslation(0, -0.5, 0),
    ground,
  );

  // Four walls so cubes stay in the arena.
  const wallSpecs: ReadonlyArray<{ hx: number; hy: number; hz: number; x: number; z: number }> = [
    { hx: GROUND_HALF, hy: WALL_H / 2, hz: 0.5, x: 0, z: GROUND_HALF },
    { hx: GROUND_HALF, hy: WALL_H / 2, hz: 0.5, x: 0, z: -GROUND_HALF },
    { hx: 0.5, hy: WALL_H / 2, hz: GROUND_HALF, x: GROUND_HALF, z: 0 },
    { hx: 0.5, hy: WALL_H / 2, hz: GROUND_HALF, x: -GROUND_HALF, z: 0 },
  ];
  for (const wall of wallSpecs) {
    const wallBody = w.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    w.createCollider(
      RAPIER.ColliderDesc.cuboid(wall.hx, wall.hy, wall.hz).setTranslation(wall.x, wall.hy, wall.z),
      wallBody,
    );
  }

  for (let i = 0; i < CUBE_COUNT; i += 1) {
    const savedCube = saved ? saved[i] : undefined;
    const color = savedCube?.color ?? PALETTE[i % PALETTE.length]!;
    const pos = savedCube ? { x: savedCube.p[0], y: savedCube.p[1], z: savedCube.p[2] } : defaultStackPos(i);
    const desc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(pos.x, pos.y, pos.z)
      .setLinearDamping(0.08)
      .setAngularDamping(0.12);
    if (savedCube) {
      desc.setRotation({ x: savedCube.q[0], y: savedCube.q[1], z: savedCube.q[2], w: savedCube.q[3] });
    }
    const body = w.createRigidBody(desc);
    w.createCollider(
      RAPIER.ColliderDesc.cuboid(CUBE_HALF, CUBE_HALF, CUBE_HALF)
        .setRestitution(0.35)
        .setFriction(0.7)
        .setDensity(1),
      body,
    );
    const rec: CubeRec = { id: i, body, color };
    cubes.push(rec);
    byId.set(i, rec);
  }

  world = w;
}

function defaultStackPos(i: number): Vec3 {
  const perRow = 5;
  const perLayer = perRow * perRow;
  const step = CUBE_HALF * 2 + 0.06;
  const within = i % perLayer;
  const layer = Math.floor(i / perLayer);
  const col = within % perRow;
  const row = Math.floor(within / perRow);
  return {
    x: (col - (perRow - 1) / 2) * step,
    y: CUBE_HALF + 0.02 + layer * (CUBE_HALF * 2 + 0.02),
    z: (row - (perRow - 1) / 2) * step,
  };
}

function persist(c: SubstrateContext): Promise<unknown> {
  const saved: SavedCube[] = cubes.map((cube) => {
    const t = cube.body.translation();
    const r = cube.body.rotation();
    return {
      id: cube.id,
      color: cube.color,
      p: [round(t.x, 3), round(t.y, 3), round(t.z, 3)],
      q: [round(r.x, 4), round(r.y, 4), round(r.z, 4), round(r.w, 4)],
    };
  });
  return c.state.write({ v: 1, cubes: saved });
}

function readSaved(value: unknown): readonly SavedCube[] | null {
  if (!isRecord(value) || value["v"] !== 1 || !Array.isArray(value["cubes"])) return null;
  const out: SavedCube[] = [];
  for (const entry of value["cubes"]) {
    if (!isRecord(entry)) continue;
    const p = entry["p"];
    const q = entry["q"];
    if (!Array.isArray(p) || p.length !== 3 || !Array.isArray(q) || q.length !== 4) continue;
    out.push({
      id: numberOr(entry["id"], out.length),
      color: typeof entry["color"] === "string" ? entry["color"] : PALETTE[out.length % PALETTE.length]!,
      p: [num(p[0]), num(p[1]), num(p[2])],
      q: [num(q[0]), num(q[1]), num(q[2]), num(q[3])],
    });
  }
  return out.length > 0 ? out : null;
}

function assignColor(c: SubstrateContext, playerId: string): string {
  const existing = playerColors.get(playerId);
  if (existing) return existing;
  const color = PALETTE[Math.floor(c.rng() * PALETTE.length) % PALETTE.length]!;
  playerColors.set(playerId, color);
  return color;
}

function broadcastInfo(c: SubstrateContext): void {
  c.ws.send("all", { type: "info", players: playerColors.size });
}

function randomPop(c: SubstrateContext): Vec3 {
  const angle = c.rng() * Math.PI * 2;
  return { x: Math.cos(angle) * 9, y: 15, z: Math.sin(angle) * 9 };
}

function asVec(value: unknown): Vec3 | null {
  if (Array.isArray(value) && value.length >= 3) {
    return { x: num(value[0]), y: num(value[1]), z: num(value[2]) };
  }
  if (isRecord(value) && "x" in value && "y" in value && "z" in value) {
    return { x: num(value["x"]), y: num(value["y"]), z: num(value["z"]) };
  }
  return null;
}

function clampVec(v: Vec3, max: number): Vec3 {
  const mag = Math.hypot(v.x, v.y, v.z);
  if (mag <= max || mag === 0) return v;
  const k = max / mag;
  return { x: v.x * k, y: v.y * k, z: v.z * k };
}

function round(value: number, places: number): number {
  const f = 10 ** places;
  return Math.round(value * f) / f;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
