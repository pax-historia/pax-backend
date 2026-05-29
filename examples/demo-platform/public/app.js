import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

const $ = (id) => document.getElementById(id);
const MOTION_EPSILON = 0.025;

// ---- three.js scene ----
const renderer = new THREE.WebGLRenderer({ canvas: $("c"), antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
renderer.shadowMap.enabled = true;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0f1a);
scene.fog = new THREE.Fog(0x0b0f1a, 40, 90);

const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 500);
camera.position.set(20, 18, 24);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.target.set(0, 1, 0);
controls.maxPolarAngle = Math.PI * 0.49;

scene.add(new THREE.HemisphereLight(0xbcd4ff, 0x10131c, 0.9));
const sun = new THREE.DirectionalLight(0xffffff, 1.4);
sun.position.set(18, 30, 12);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
sun.shadow.camera.left = -30;
sun.shadow.camera.right = 30;
sun.shadow.camera.top = 30;
sun.shadow.camera.bottom = -30;
scene.add(sun);

const raycaster = new THREE.Raycaster();
const cubes = new Map(); // id -> { mesh, render, target }
const cubeMeshes = [];
const materialByColor = new Map();
let cubeGeometry = null;
let cubeSize = 1;
let ws = null;
let nextInputSeq = 1;

const perf = {
  lastRafAt: performance.now(),
  frameDeltas: [],
  receiveGaps: [],
  completedInputs: [],
  pendingInputs: new Map(),
  stateFrames: 0,
  stateRows: 0,
  lastStateAt: 0,
  lastTickSeq: null,
  tickGaps: 0,
  longestFrameMs: 0,
  over50: 0,
  over100: 0,
  over250: 0,
};

window.__paxCubePerf = {
  report: buildPerfReport,
  pendingInputs: perf.pendingInputs,
  completedInputs: perf.completedInputs,
};

function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener("resize", resize);
resize();

function buildArena(half, wallH) {
  const floor = new THREE.Mesh(
    new THREE.BoxGeometry(half * 2, 1, half * 2),
    new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: 0.95 }),
  );
  floor.position.y = -0.5;
  floor.receiveShadow = true;
  scene.add(floor);

  const grid = new THREE.GridHelper(half * 2, half * 2, 0x334155, 0x1f2a3a);
  grid.position.y = 0.01;
  scene.add(grid);

  const wallMat = new THREE.MeshStandardMaterial({ color: 0x2a3550, transparent: true, opacity: 0.18 });
  const specs = [
    [half * 2, wallH, 0.4, 0, wallH / 2, half],
    [half * 2, wallH, 0.4, 0, wallH / 2, -half],
    [0.4, wallH, half * 2, half, wallH / 2, 0],
    [0.4, wallH, half * 2, -half, wallH / 2, 0],
  ];
  for (const [sx, sy, sz, x, y, z] of specs) {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), wallMat);
    wall.position.set(x, y, z);
    scene.add(wall);
  }
}

function buildCubes(bodies) {
  cubeGeometry = new THREE.BoxGeometry(cubeSize, cubeSize, cubeSize);

  bodies.forEach((body) => {
    const mesh = new THREE.Mesh(cubeGeometry, materialForColor(body.color));
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.id = body.id;
    mesh.position.set(0, -100, 0);
    scene.add(mesh);
    cubeMeshes.push(mesh);
    cubes.set(body.id, {
      id: body.id,
      mesh,
      render: { p: new THREE.Vector3(0, -100, 0), q: new THREE.Quaternion() },
      target: { p: new THREE.Vector3(0, -100, 0), q: new THREE.Quaternion() },
    });
  });
}

function materialForColor(color) {
  let material = materialByColor.get(color);
  if (!material) {
    material = new THREE.MeshStandardMaterial({
      color: new THREE.Color(color),
      roughness: 0.4,
      metalness: 0.1,
    });
    materialByColor.set(color, material);
  }
  return material;
}

// ---- networking ----
async function join() {
  $("err").textContent = "";
  $("join").disabled = true;
  let data;
  try {
    const res = await fetch("/join", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: $("name").value }),
    });
    data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.detail || data.error || `HTTP ${res.status}`);
  } catch (err) {
    $("err").textContent = "could not join: " + err.message;
    $("join").disabled = false;
    return;
  }

  $("gate").classList.add("hidden");
  $("hud").classList.remove("hidden");
  $("tools").classList.remove("hidden");
  $("perf").classList.remove("hidden");
  $("room").textContent = data.gameId;
  $("me").textContent = data.playerId;
  connect(data.webSocketUrl);
}

function connect(url) {
  setStatus("connecting...");
  ws = new WebSocket(url);
  ws.onopen = () => setStatus("");
  ws.onclose = () => { setStatus("disconnected; rejoining..."); setTimeout(rejoin, 1500); };
  ws.onerror = () => setStatus("connection error");
  ws.onmessage = (ev) => {
    const receivedAt = performance.now();
    let frame;
    try { frame = JSON.parse(ev.data); } catch { return; }
    if (frame.type === "init") onInit(frame);
    else if (frame.type === "s") onState(frame, receivedAt);
    else if (frame.type === "info") $("pill").textContent = String(frame.players);
  };
}

async function rejoin() {
  // Re-run placement (sessions are not resumable) and reconnect.
  try {
    const res = await fetch("/join", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: $("me").textContent }),
    });
    const data = await res.json();
    if (data.ok) connect(data.webSocketUrl);
    else setStatus("rejoin failed");
  } catch {
    setStatus("rejoin failed");
  }
}

function onInit(frame) {
  cubeSize = (frame.world?.cube ?? 0.5) * 2;
  if (cubeMeshes.length === 0) {
    buildArena(frame.world?.half ?? 14, frame.world?.wallH ?? 8);
    buildCubes(frame.bodies ?? []);
  }
}

function onState(frame, receivedAt) {
  if (perf.lastStateAt > 0) pushSample(perf.receiveGaps, receivedAt - perf.lastStateAt, 600);
  perf.lastStateAt = receivedAt;
  perf.stateFrames += 1;
  perf.stateRows += Array.isArray(frame.b) ? frame.b.length : 0;
  if (typeof frame.t === "number") {
    if (perf.lastTickSeq !== null && frame.t > perf.lastTickSeq + 1) perf.tickGaps += frame.t - perf.lastTickSeq - 1;
    perf.lastTickSeq = frame.t;
  }

  for (const row of frame.b ?? []) {
    const rec = cubes.get(row[0]);
    if (!rec) continue;
    const nextP = new THREE.Vector3(row[1], row[2], row[3]);
    rec.target.p.copy(nextP);
    rec.target.q.set(row[4], row[5], row[6], row[7]);
    markRelevantState(row[0], nextP, receivedAt, frame.t);
  }
}

function setStatus(text) { $("status").textContent = text; }

// ---- throw input ----
let downAt = null;
renderer.domElement.addEventListener("pointerdown", (e) => { downAt = { x: e.clientX, y: e.clientY }; });
renderer.domElement.addEventListener("pointerup", (e) => {
  if (!downAt) return;
  const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y);
  downAt = null;
  if (moved > 6 || !ws || ws.readyState !== WebSocket.OPEN) return; // a drag = orbit, not a throw

  const ndc = new THREE.Vector2(
    (e.clientX / window.innerWidth) * 2 - 1,
    -(e.clientY / window.innerHeight) * 2 + 1,
  );
  raycaster.setFromCamera(ndc, camera);
  const hit = raycaster.intersectObjects(cubeMeshes, false)[0];
  if (!hit) return;

  const id = hit.object.userData.id;
  const rec = cubes.get(id);
  if (!rec) return;
  const dir = hit.point.clone().sub(camera.position).normalize();
  const strength = 26;
  const impulse = [dir.x * strength, dir.y * strength + 9, dir.z * strength];
  const inputSeq = nextInputSeq++;
  const inputAt = performance.now();
  perf.pendingInputs.set(inputSeq, {
    inputSeq,
    id,
    inputAt,
    sendAt: performance.now(),
    baseP: rec.render.p.clone(),
  });
  ws.send(JSON.stringify({ type: "throw", id, impulse, probe: { inputSeq } }));
});

$("shove").addEventListener("click", () => {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "shove" }));
});
$("reset").addEventListener("click", () => {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "reset" }));
});
$("join").addEventListener("click", join);
$("name").addEventListener("keydown", (e) => { if (e.key === "Enter") join(); });

// ---- render loop (interpolate toward latest server state) ----
function tick(now) {
  const dt = Math.min(100, now - perf.lastRafAt);
  perf.lastRafAt = now;
  recordFrameDelta(dt);
  const alpha = 1 - Math.exp(-14 * dt / 1000);

  for (const rec of cubes.values()) {
    rec.render.p.lerp(rec.target.p, alpha);
    rec.render.q.slerp(rec.target.q, alpha);
    rec.mesh.position.copy(rec.render.p);
    rec.mesh.quaternion.copy(rec.render.q);
    markVisibleMotion(rec, now);
  }
  controls.update();
  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

function markRelevantState(id, nextP, receivedAt, tickSeq) {
  for (const pending of perf.pendingInputs.values()) {
    if (pending.id !== id || pending.firstRelevantStateAt !== undefined) continue;
    if (pending.baseP.distanceTo(nextP) <= MOTION_EPSILON) continue;
    pending.firstRelevantStateAt = receivedAt;
    pending.firstRelevantTickSeq = tickSeq;
  }
}

function markVisibleMotion(rec, now) {
  for (const [inputSeq, pending] of perf.pendingInputs) {
    if (pending.id !== rec.id || pending.visibleMotionAt !== undefined) continue;
    if (pending.baseP.distanceTo(rec.render.p) <= MOTION_EPSILON) continue;
    pending.visibleMotionAt = now;
    perf.pendingInputs.delete(inputSeq);
    const completed = {
      inputSeq,
      id: pending.id,
      inputToStateMs: pending.firstRelevantStateAt === undefined ? null : pending.firstRelevantStateAt - pending.inputAt,
      inputToVisibleMs: pending.visibleMotionAt - pending.inputAt,
      sendToVisibleMs: pending.visibleMotionAt - pending.sendAt,
      firstRelevantTickSeq: pending.firstRelevantTickSeq ?? null,
    };
    perf.completedInputs.push(completed);
    if (perf.completedInputs.length > 60) perf.completedInputs.shift();
    console.info("[cube-perf] input visible", completed);
  }
}

function recordFrameDelta(dt) {
  pushSample(perf.frameDeltas, dt, 600);
  perf.longestFrameMs = Math.max(perf.longestFrameMs, dt);
  if (dt > 50) perf.over50 += 1;
  if (dt > 100) perf.over100 += 1;
  if (dt > 250) perf.over250 += 1;
}

function buildPerfReport() {
  const inputVisible = perf.completedInputs
    .map((input) => input.inputToVisibleMs)
    .filter((value) => typeof value === "number");
  const inputState = perf.completedInputs
    .map((input) => input.inputToStateMs)
    .filter((value) => typeof value === "number");
  return {
    fps: rounded(1000 / (percentile(perf.frameDeltas, 0.5) || 16.7), 1),
    frameMsP95: rounded(percentile(perf.frameDeltas, 0.95), 1),
    frameMsP99: rounded(percentile(perf.frameDeltas, 0.99), 1),
    longestFrameMs: rounded(perf.longestFrameMs, 1),
    framesOver50Ms: perf.over50,
    framesOver100Ms: perf.over100,
    framesOver250Ms: perf.over250,
    wsGapMsP95: rounded(percentile(perf.receiveGaps, 0.95), 1),
    stateFrames: perf.stateFrames,
    avgRowsPerState: perf.stateFrames > 0 ? rounded(perf.stateRows / perf.stateFrames, 1) : 0,
    tickGaps: perf.tickGaps,
    pendingInputs: perf.pendingInputs.size,
    inputToStateMsP95: rounded(percentile(inputState, 0.95), 1),
    inputToVisibleMsP50: rounded(percentile(inputVisible, 0.5), 1),
    inputToVisibleMsP95: rounded(percentile(inputVisible, 0.95), 1),
    drawCalls: renderer.info.render.calls,
  };
}

function renderPerfOverlay() {
  const report = buildPerfReport();
  $("perf").textContent = [
    `fps ${report.fps} | frame p95 ${report.frameMsP95}ms p99 ${report.frameMsP99}ms`,
    `input->visible p50 ${report.inputToVisibleMsP50}ms p95 ${report.inputToVisibleMsP95}ms pending ${report.pendingInputs}`,
    `ws gap p95 ${report.wsGapMsP95}ms | avg rows ${report.avgRowsPerState} | tick gaps ${report.tickGaps}`,
    `draw calls ${report.drawCalls} | longest frame ${report.longestFrameMs}ms`,
  ].join("\n");
}
setInterval(renderPerfOverlay, 500);

function pushSample(samples, value, max) {
  if (!Number.isFinite(value)) return;
  samples.push(value);
  if (samples.length > max) samples.shift();
}

function percentile(values, q) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[index] ?? 0;
}

function rounded(value, places) {
  const f = 10 ** places;
  return Math.round((value || 0) * f) / f;
}
