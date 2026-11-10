#!/usr/bin/env node
/* global console */
/**
 * Step 72 (T13, global plan V35.24): writes the recorded-style GPS traces next to this file. Deterministic (seeded
 * PRNG, fixed start time): running it again gives the same bytes. No real person's data: the "road" is a polyline of
 * public map coordinates (README.md), the car is simulated along it, then the defects real phones show are added.
 *   node test/fixtures/traces/generate.mjs
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const R = 6371008.8;
const rad = (d) => (d * Math.PI) / 180;
const meters = (a, b) => {
  const dLat = rad(b[0] - a[0]);
  const dLng = rad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};
const bearing = (a, b) => {
  const y = Math.sin(rad(b[1] - a[1])) * Math.cos(rad(b[0]));
  const x = Math.cos(rad(a[0])) * Math.sin(rad(b[0])) - Math.sin(rad(a[0])) * Math.cos(rad(b[0])) * Math.cos(rad(b[1] - a[1]));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
};
/** Moves `m` metres north and `e` metres east. */
const offset = (p, north, east) => [p[0] + north / 111_320, p[1] + east / (111_320 * Math.cos(rad(p[0])))];
const round = (x, d) => Math.round(x * 10 ** d) / 10 ** d;

/** mulberry32: a small seeded PRNG, so every run is identical. */
function prng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const gauss = () => Math.sqrt(-2 * Math.log(1 - next())) * Math.cos(2 * Math.PI * next());
  return { next, gauss };
}

/** The point `d` metres along the polyline (OSRM-like geometry: straight segments between road vertices). */
function along(line, d) {
  let left = d;
  for (let i = 1; i < line.length; i++) {
    const seg = meters(line[i - 1], line[i]);
    if (left <= seg) {
      const f = seg === 0 ? 0 : left / seg;
      return { p: [line[i - 1][0] + (line[i][0] - line[i - 1][0]) * f, line[i - 1][1] + (line[i][1] - line[i - 1][1]) * f], heading: bearing(line[i - 1], line[i]), seg: i - 1 };
    }
    left -= seg;
  }
  const n = line.length - 1;
  return { p: line[n], heading: bearing(line[n - 1], line[n]), seg: n - 1 };
}
const lengthOf = (line) => line.slice(1).reduce((s, p, i) => s + meters(line[i], p), 0);
const distAt = (line, vertex) => lengthOf(line.slice(0, vertex + 1));

function build(spec) {
  const rnd = prng(spec.seed);
  const road = spec.road;
  const roadM = lengthOf(road);
  const tunnel = [distAt(road, spec.tunnel[0]), distAt(road, spec.tunnel[1])];
  const fixes = [];
  const push = (t, truthM, p, accuracy, extra = {}) => {
    const truth = along(road, truthM);
    fixes.push({
      t,
      lat: round(p[0], 6),
      lng: round(p[1], 6),
      accuracy: Math.round(accuracy),
      ...(extra.speedMps !== undefined ? { speedMps: round(extra.speedMps, 1) } : {}),
      heading: Math.round(extra.heading ?? truth.heading),
      truthM: Math.round(truthM),
      ...(extra.defect ? { defect: extra.defect } : {}),
    });
  };
  const jitter = (p, sigma) => offset(p, rnd.gauss() * sigma, rnd.gauss() * sigma);

  // 1. Parked at the pickup, waiting for the rider: standing still, the fix drifts 10–35 m (phase "waiting").
  let t = 0;
  for (; t < 120; t += 10) push(t, 0, jitter(road[0], 14), 12 + rnd.next() * 20, { speedMps: 0, defect: "parked_drift" });
  const boardAt = t;
  // 2. On board: the car moves along the road at city speed, a fix every 5 s; red lights; the defects.
  let d = 0;
  const noisy = [roadM * spec.noisyFrom, roadM * (spec.noisyFrom + 0.08)];
  let gapUntil = -1;
  let backwardsDone = false;
  let lowDone = 0;
  let dupDone = 0;
  let redLight = 0;
  let gap90Done = false;
  let jamDone = false;
  let gap45Done = false;
  while (d < roadM) {
    t += 5;
    const speed = redLight > 0 ? 0 : 6 + 8 * rnd.next();
    if (redLight > 0) redLight -= 5;
    d = Math.min(roadM, d + speed * 5);
    if (redLight === 0 && rnd.next() < 0.04) redLight = 30 + Math.round(rnd.next() * 6) * 5; // a red light / jam 30–60 s
    if (!jamDone && d > roadM * 0.5) { jamDone = true; redLight = 60; } // every trace stands still once, 60 s
    const truth = along(road, d);
    const inTunnel = d > tunnel[0] && d < tunnel[1];
    if (inTunnel) continue; // no satellites in the tunnel
    if (!gap45Done && d > roadM * spec.gapAt) { gapUntil = t + 45; gap45Done = true; }
    if (!gap90Done && d > roadM * spec.gap90At) { gapUntil = t + 90; gap90Done = true; }
    if (t < gapUntil) continue; // signal lost (30–90 s with no fix)
    if (d > noisy[0] && d < noisy[1]) {
      // A stretch between tall buildings: 30–40 m noise, the phone still says 35–45 m (usable by the ≤ 50 m rule).
      push(t, d, jitter(truth.p, 32), 35 + rnd.next() * 10, { speedMps: speed, defect: "urban_canyon_noise" });
      continue;
    }
    if (!backwardsDone && d > roadM * spec.backwardsAt) {
      // A confident fix far behind the car (multipath/Wi-Fi snap), then the true position again.
      backwardsDone = true;
      const back = along(road, Math.max(0, d - 450));
      push(t, d, jitter(back.p, 3), 20, { speedMps: speed, defect: "backwards_jump" });
      continue;
    }
    if (lowDone < 4 && d > roadM * spec.lowAt) {
      lowDone++;
      const acc = 120 + rnd.next() * 180;
      push(t, d, offset(truth.p, acc * 0.8 * (rnd.next() - 0.5) * 2, acc * 0.8 * (rnd.next() - 0.5) * 2), acc, { defect: "low_accuracy" });
      continue;
    }
    push(t, d, jitter(truth.p, speed === 0 ? 12 : 5), 5 + rnd.next() * 10, { speedMps: speed, ...(redLight > 0 && speed === 0 ? { defect: "stopped_drift" } : {}) });
    if (dupDone < 3 && d > roadM * spec.dupAt) {
      dupDone++;
      const last = fixes[fixes.length - 1];
      // The OS hands the same fix twice (same measuredAt): once identical, then the same time with other coordinates.
      fixes.push({ ...last, defect: "duplicate_timestamp" });
      if (dupDone === 2) {
        const moved = offset([last.lat, last.lng], 12, -9);
        fixes.push({ ...last, lat: round(moved[0], 6), lng: round(moved[1], 6), defect: "duplicate_timestamp_other_place" });
      }
    }
  }
  // 3. At the drop-off: parked 60 s while the rider pays, the fix drifts.
  const arriveAt = t;
  for (let k = 0; k < 6; k++) { t += 10; push(t, roadM, jitter(road[road.length - 1], 14), 12 + rnd.next() * 20, { speedMps: 0, defect: "parked_drift" }); }

  // 4. How the app sends them: a batch every ~30 s; one batch shuffled; one batch held back and sent late.
  const onBoard = fixes.map((f, i) => ({ f, i })).filter(({ f }) => f.t > boardAt);
  const waiting = fixes.map((f, i) => ({ f, i })).filter(({ f }) => f.t <= boardAt);
  const batches = [];
  const chunk = (list, phase) => {
    let cur = [];
    let start = list[0]?.f.t ?? 0;
    for (const item of list) {
      if (item.f.t - start >= 30 && cur.length) { batches.push({ phase, sendT: cur[cur.length - 1].f.t + 2, fixes: cur.map((c) => c.i) }); cur = []; start = item.f.t; }
      cur.push(item);
    }
    if (cur.length) batches.push({ phase, sendT: cur[cur.length - 1].f.t + 2, fixes: cur.map((c) => c.i) });
  };
  chunk(waiting, "waiting");
  chunk(onBoard, "on_board");
  const board = batches.filter((b) => b.phase === "on_board");
  const shuffled = board[Math.floor(board.length * 0.3)];
  shuffled.fixes = [...shuffled.fixes].sort(() => rnd.next() - 0.5);
  shuffled.defect = "out_of_order_in_batch";
  const lateIdx = Math.floor(board.length * 0.6);
  const late = board[lateIdx];
  late.sendT = board[lateIdx + 1].sendT + 5; // arrives after the next batch (bad connection)
  late.defect = "late_batch_out_of_order";
  batches.sort((a, b) => a.sendT - b.sendT);

  return {
    name: spec.name,
    city: spec.city,
    zoneId: spec.zoneId,
    description: spec.description,
    generatedBy: "test/fixtures/traces/generate.mjs (deterministic, seed " + spec.seed + ")",
    pickup: { address: spec.pickupName, lat: road[0][0], lng: road[0][1] },
    dropoff: { address: spec.dropoffName, lat: road[road.length - 1][0], lng: road[road.length - 1][1] },
    roadMeters: Math.round(roadM),
    road: road.map(([lat, lng]) => ({ lat, lng })),
    tunnel: { name: spec.tunnelName, fromMeters: Math.round(tunnel[0]), toMeters: Math.round(tunnel[1]) },
    boardT: boardAt,
    arriveT: arriveAt,
    defects: [...new Set([...fixes.map((f) => f.defect).filter(Boolean), "tunnel", "gap_45s", "gap_90s", "out_of_order_in_batch", "late_batch_out_of_order"])].sort(),
    fixes,
    batches,
  };
}

const TRACES = [
  {
    name: "stockholm_sergels_medborgar",
    city: "Stockholm",
    zoneId: "Z001",
    seed: 4601,
    description: "Sergels torg → Centralbron → Slussen → Söderledstunneln → Ringvägen → Götgatan → Medborgarplatsen",
    pickupName: "Sergels torg",
    dropoffName: "Medborgarplatsen",
    tunnelName: "Söderledstunneln",
    road: [[59.3326, 18.0649], [59.3312, 18.061], [59.33, 18.0585], [59.3275, 18.061], [59.324, 18.065], [59.3215, 18.069], [59.3195, 18.0722], [59.316, 18.074], [59.312, 18.076], [59.3105, 18.0745], [59.3112, 18.0712], [59.3135, 18.0722], [59.3143, 18.0735]],
    tunnel: [6, 8],
    noisyFrom: 0.05, gapAt: 0.25, gap90At: 0.82, backwardsAt: 0.3, lowAt: 0.4, dupAt: 0.15,
  },
  {
    name: "paris_chatelet_eiffel",
    city: "Paris",
    zoneId: "FR-PC",
    seed: 7502,
    description: "Châtelet → voie Georges-Pompidou → tunnel des Tuileries → Concorde → Cours la Reine → Alma → Quai Branly → Tour Eiffel",
    pickupName: "Place du Châtelet",
    dropoffName: "Tour Eiffel",
    tunnelName: "Tunnel des Tuileries",
    road: [[48.858, 2.347], [48.8588, 2.342], [48.8598, 2.338], [48.861, 2.333], [48.8622, 2.329], [48.8636, 2.325], [48.8648, 2.3215], [48.865, 2.317], [48.8645, 2.31], [48.864, 2.304], [48.8636, 2.301], [48.8618, 2.2985], [48.86, 2.2965], [48.8583, 2.2945]],
    tunnel: [4, 6],
    noisyFrom: 0.1, gapAt: 0.45, gap90At: 0.7, backwardsAt: 0.6, lowAt: 0.2, dupAt: 0.3,
  },
  {
    name: "tunis_bourguiba_carthage",
    city: "Tunis",
    zoneId: "TN-TC",
    seed: 2161,
    description: "Avenue Habib Bourguiba → Place du 14 Janvier → Avenue Mohamed V (trémie) → Charguia → Aéroport Tunis-Carthage (owner TN-9)",
    pickupName: "Avenue Habib Bourguiba, Tunis",
    dropoffName: "Aéroport Tunis-Carthage",
    tunnelName: "Trémie de l'avenue Mohamed V",
    road: [[36.8008, 10.18], [36.8, 10.185], [36.7995, 10.188], [36.804, 10.1875], [36.81, 10.1865], [36.816, 10.1855], [36.8205, 10.186], [36.826, 10.19], [36.832, 10.196], [36.839, 10.204], [36.845, 10.213], [36.849, 10.221], [36.851, 10.2272]],
    tunnel: [5, 6],
    noisyFrom: 0.15, gapAt: 0.55, gap90At: 0.75, backwardsAt: 0.35, lowAt: 0.85, dupAt: 0.6,
  },
];

for (const spec of TRACES) {
  const trace = build(spec);
  writeFileSync(join(HERE, `${spec.name}.json`), `${JSON.stringify(trace, null, 1)}\n`);
  console.log(`${spec.name}: ${trace.fixes.length} fixes, ${trace.batches.length} batches, road ${trace.roadMeters} m, ${trace.arriveT - trace.boardT} s on board, defects ${trace.defects.join(", ")}`);
}
