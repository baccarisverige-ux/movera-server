/* global process, console, fetch, performance, Buffer, AbortController, setTimeout, clearTimeout, setInterval, clearInterval, URL */
// Job 1 "Fast dispatch" load test — PRIVATE local copy only, never a live server.
//
//   LOADTEST_ADMIN_URL="postgres://movera:movera@localhost/movera?host=/var/tmp/movera-pg" \
//   node tools/loadtest/dispatch-load.mjs --dist dist --db movera_load_job1 --steps 50,75,100,200,400 --seconds 90 \
//        --spikes 800,1200 --spike-seconds 45 --out /tmp/load-result.json
//
// It makes a NEW database (refuses a name not starting with movera_load_), migrates it with the server build, writes the
// contract sample settings for Z001 (Stockholm), seeds drivers (online, inside Z001) and riders with sessions straight
// in the database, starts that build on 127.0.0.1 and drives traffic at each step's rate: rider quotes + bookings
// (≈ 0.8 trips/min per req/s, as the 2026-11-04 stress test), driver GPS, offer lists, accept / decline, rider map,
// trip reads, admin live map. A spike step is followed by a "rest" step at 100 req/s (recovery while load goes on).
// Measured per step: request → first offer (offers.sent_at − trips.created_at, from the database), HTTP p95 and status
// counts, overdue timers (sampled), offer-feed (SSE) delay for 20 drivers. The test passes when the first-offer p95 is
// under --target-ms (5000) at every non-spike step up to 200 req/s. The database is dropped at the end (--keep keeps it).
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import pg from "pg";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const DIST = path.resolve(arg("dist", "dist"));
const DB = arg("db", "movera_load_job1");
const STEPS = arg("steps", "50,100,200").split(",").map(Number);
const SPIKES = (arg("spikes", "") || "").split(",").filter(Boolean).map(Number);
const SECONDS = Number(arg("seconds", "90"));
const SPIKE_SECONDS = Number(arg("spike-seconds", "45"));
const DRIVERS = Number(arg("drivers", "300"));
const RIDERS = Number(arg("riders", "4000"));
const PORT = Number(arg("port", "18181"));
const TARGET_MS = Number(arg("target-ms", "5000"));
const OUT = arg("out", "");
const KEEP = process.argv.includes("--keep");
const ADMIN_URL = process.env.LOADTEST_ADMIN_URL;
if (!ADMIN_URL) throw new Error("set LOADTEST_ADMIN_URL (a LOCAL postgres admin url)");
if (!/^movera_load_[a-z0-9_]+$/.test(DB)) throw new Error("--db must start with movera_load_ (a private copy)");
const urlFor = (db) => {
  const u = new URL(ADMIN_URL);
  u.pathname = `/${db}`;
  return u.toString();
};
const JWT = "load-test-secret-0123456789-abcdefghijklmnopqrstuvwxyz";
const B = `http://127.0.0.1:${PORT}/api/v1`;
const imp = (p) => import(path.join(DIST, p));

/* ------------------------------------------------------------ database + seed */
const admin = new pg.Client({ connectionString: ADMIN_URL });
await admin.connect();
await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
await admin.query(`CREATE DATABASE ${DB}`);
const { createPool, createDb } = await imp("db/db.js");
const { migrate } = await imp("db/migrate.js");
const { seedDriver } = await imp("drivers/service.js");
const { startSession } = await imp("auth/service.js");
const { signAccessToken } = await imp("auth/jwt.js");
const { newId } = await imp("ids.js");
const { createAdmin } = await imp("admin/auth.js");
const { permissionsOf } = await imp("admin/permissions.js");
const { CONTRACTS_DIR } = await imp("contract/contract.js");
const pool = createPool(urlFor(DB), 5);
await migrate(pool);
const db = createDb(pool);
const t0 = new Date();
const sample = (n) => fs.readFileSync(`${CONTRACTS_DIR}/fixtures/config/${n}.json`, "utf8");
for (const doc of ["dispatch", "pricing", "driver_app_config", "rider_app_config"]) {
  const file = { dispatch: "dispatch_document", pricing: "pricing_document", driver_app_config: "driver_app_config", rider_app_config: "rider_app_config" }[doc];
  await db.insertInto("config_live").values({ doc, zone_id: "Z001", version: 1, document: sample(file), published_at: t0, published_by: null }).onConflict((c) => c.columns(["doc", "zone_id"]).doNothing()).execute();
}
const CENTER = { lat: 59.3326, lng: 18.0649 };
const near = (r = 0.03) => ({ lat: CENTER.lat + (Math.random() - 0.5) * 2 * r, lng: CENTER.lng + (Math.random() - 0.5) * 4 * r });
const drivers = [];
for (let i = 0; i < DRIVERS; i++) {
  const phone = `+4670${String(9000000 + i).slice(-7)}`;
  const made = await db.transaction().execute((trx) => seedDriver(trx, { phone, firstName: `Load ${i}`, make: "Volvo", model: "V60", year: 2022, color: "Black", plate: `LD${String(i).padStart(4, "0")}`, categoryIds: ["economy"], zoneIds: ["Z001"] }, t0));
  const s = await db.transaction().execute((trx) => startSession(trx, { jwtSecret: JWT }, { actor: "driver", subjectId: made.driverId, zones: ["Z001"] }, { ip: "127.0.0.1", userAgent: "load" }, t0, 24 * 3600_000));
  drivers.push({ id: made.driverId, token: signAccessToken({ sub: made.driverId, actor: "driver", sid: s.sessionId, zones: ["Z001"] }, JWT, 12 * 3600, t0), at: near() });
}
await db.updateTable("drivers").set({ online_status: "online", online_since: t0, last_free_at: t0 }).execute();
const riders = [];
for (let i = 0; i < RIDERS; i++) {
  const id = newId("rdr", t0.getTime());
  await db.insertInto("riders").values({ rider_id: id, phone: `+4673${String(1000000 + i).slice(-7)}`, first_name: `Load r${i}`, status: "active", language: "sv" }).execute();
  const s = await db.transaction().execute((trx) => startSession(trx, { jwtSecret: JWT }, { actor: "rider", subjectId: id, zones: [] }, { ip: "127.0.0.1", userAgent: "load" }, t0, 24 * 3600_000));
  riders.push({ id, token: signAccessToken({ sub: id, actor: "rider", sid: s.sessionId, zones: [] }, JWT, 12 * 3600, t0), busyUntil: 0 });
}
const { adminId } = await createAdmin(db, { email: "load-admin@movera.test", name: "Load", role: "super" }, t0);
const perms = permissionsOf("super");
const as = await db.transaction().execute((trx) => startSession(trx, { jwtSecret: JWT }, { actor: "admin", subjectId: adminId, zones: ["*"], role: "super", perms }, {}, t0, 24 * 3600_000));
const adminToken = signAccessToken({ sub: adminId, actor: "admin", sid: as.sessionId, zones: ["*"], role: "super", perms }, JWT, 12 * 3600, t0);
console.log(`seeded ${drivers.length} drivers, ${riders.length} riders`);

/* ------------------------------------------------------------ server */
const server = spawn(process.execPath, [path.join(DIST, "main.js")], {
  env: { ...process.env, DATABASE_URL: urlFor(DB), PORT: String(PORT), HOST: "127.0.0.1", MOVERA_ENV: "development", JWT_SECRET: JWT, MIGRATE_ON_START: "false", LOG_LEVEL: "warn", OSRM_URL: "", FIREBASE_SERVICE_ACCOUNT: "" },
  stdio: ["ignore", "ignore", "pipe"],
});
let serverErr = "";
server.stderr.on("data", (c) => (serverErr = (serverErr + c).slice(-4000)));
for (let i = 0; i < 120; i++) {
  try {
    if ((await fetch(`http://127.0.0.1:${PORT}/healthz`)).ok) break;
  } catch { /* sample or stream lost: skip */ }
  await sleep(500);
}

/* ------------------------------------------------------------ traffic */
let phase = "warmup";
const M = {};
const P = () => (M[phase] ??= { http: {}, status: {}, trips: [], overdue: [], feed: [], sent: 0 });
let key = 0;
async function call(token, method, p, body, ep) {
  const t = performance.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 10_000);
  let status = 0;
  let json = null;
  try {
    const r = await fetch(B + p, { method, signal: ctl.signal, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "idempotency-key": `load-${Date.now()}-${key++}-abcdefghijkl` }, body: body ? JSON.stringify(body) : undefined });
    status = r.status;
    json = await r.json().catch(() => null);
  } catch {
    status = 0;
  }
  clearTimeout(timer);
  const m = P();
  m.sent++;
  (m.http[ep] ??= []).push(performance.now() - t);
  m.status[status] = (m.status[status] ?? 0) + 1;
  return { status, json };
}
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const myTrips = [];
async function bookOne() {
  const now = Date.now();
  const r = riders.find((x) => x.busyUntil < now);
  if (!r) return;
  r.busyUntil = now + 600_000;
  const pickup = { address: "Load pickup", ...near(0.02) };
  const dropoff = { address: "Load dropoff", ...near(0.03) };
  const q = await call(r.token, "POST", "/quotes", { pickup, dropoff, stops: [], categoryIds: ["economy"] }, "POST /quotes");
  const quote = q.json?.quotes?.[0];
  if (!quote) return;
  const t = await call(r.token, "POST", "/trips", { quoteId: quote.quoteId, categoryId: "economy", pickup, dropoff, stops: [], kind: "live", paymentMethod: "cash" }, "POST /trips");
  if (t.json?.tripId) {
    P().trips.push(t.json.tripId);
    myTrips.push({ id: t.json.tripId, rider: r, at: Date.now() });
  }
}
async function driverAct() {
  const d = pick(drivers);
  const x = Math.random();
  if (x < 0.55) {
    d.at = { lat: d.at.lat + (Math.random() - 0.5) * 0.001, lng: d.at.lng + (Math.random() - 0.5) * 0.001 };
    return call(d.token, "POST", "/driver/location", { fixes: [{ ...d.at, accuracy: 5, measuredAt: new Date().toISOString() }] }, "POST /driver/location");
  }
  const list = await call(d.token, "GET", "/driver/offers", null, "GET /driver/offers");
  const offer = list.json?.items?.[0];
  if (!offer) return;
  if (Math.random() < 0.5) {
    const a = await call(d.token, "POST", `/offers/${offer.offerId}/accept`, { expectedVersion: offer.version }, "POST accept");
    if (a.status === 200) {
      // The rider cancels 15 s later so the driver is free again (cancel inside the free minutes).
      setTimeout(async () => {
        const trip = await call(adminToken, "GET", `/admin/trips/${offer.tripId}`, null, "GET admin trip");
        const v = trip.json?.version ?? trip.json?.trip?.version;
        const r = myTrips.find((m) => m.id === offer.tripId)?.rider;
        if (r && v) await call(r.token, "POST", `/trips/${offer.tripId}/cancel`, { expectedVersion: v, reasonCode: "plans_changed" }, "POST rider cancel");
        if (r) r.busyUntil = 0;
      }, 15_000);
    }
  } else await call(d.token, "POST", `/offers/${offer.offerId}/decline`, { expectedVersion: offer.version, reasonCode: "too_far" }, "POST decline");
}
async function riderAct() {
  const r = pick(riders);
  if (Math.random() < 0.7) return call(r.token, "GET", `/rider/nearby-vehicles?lat=${CENTER.lat}&lng=${CENTER.lng}`, null, "GET nearby");
  const t = pick(myTrips.length ? myTrips : [{ id: "trp_none", rider: r }]);
  return call(t.rider.token, "GET", `/trips/${t.id}`, null, "GET trip");
}
async function oneRequest() {
  const bookShare = (0.8 / 60) / 2; // ≈ 0.8 trips / min per req/s, 2 requests per booking
  const x = Math.random();
  if (x < bookShare * 2) return bookOne();
  if (x < 0.62) return driverAct();
  if (x < 0.99) return riderAct();
  return call(adminToken, "GET", "/admin/live/drivers", null, "GET admin live drivers");
}
async function runStep(name, rate, seconds) {
  phase = name;
  P();
  const end = Date.now() + seconds * 1000;
  const sampler = setInterval(async () => {
    try {
      const r = await pool.query("SELECT count(*)::int AS n FROM timers WHERE due_at < now() - interval '2 seconds'");
      P().overdue.push(r.rows[0].n);
    } catch { /* sample or stream lost: skip */ }
  }, 5000);
  const inflight = new Set();
  let next = performance.now();
  while (Date.now() < end) {
    next += 1000 / rate;
    const p = oneRequest().catch(() => undefined);
    inflight.add(p);
    p.finally(() => inflight.delete(p));
    const wait = next - performance.now();
    if (wait > 0) await sleep(wait);
  }
  clearInterval(sampler);
  console.log(`${name} done (${P().sent} requests, ${inflight.size} still running)`);
}
// Offer feed (SSE) for 20 drivers: delay = received − occurredAt (same machine clock).
void drivers.slice(0, 20).map((d) =>
  (async () => {
    try {
      const r = await fetch(`${B}/driver/offers/stream`, { headers: { authorization: `Bearer ${d.token}`, accept: "text/event-stream" } });
      let buf = "";
      for await (const chunk of r.body) {
        buf += Buffer.from(chunk).toString();
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const data = block.split("\n").find((l) => l.startsWith("data:"));
          if (!data) continue;
          try {
            const e = JSON.parse(data.slice(5));
            if (e.kind === "offer_created" && e.occurredAt) P().feed.push(Date.now() - Date.parse(e.occurredAt));
          } catch { /* sample or stream lost: skip */ }
        }
      }
    } catch { /* sample or stream lost: skip */ }
  })(),
);
const plan = [...STEPS.map((r) => [`s${r}`, r, SECONDS])];
for (const s of SPIKES) plan.push([`spike${s}`, s, SPIKE_SECONDS], [`rest_after_${s}`, 100, SECONDS]);
for (const [name, rate, seconds] of plan) await runStep(name, rate, seconds);
phase = "drain";
await sleep(20_000);

/* ------------------------------------------------------------ results */
const q = (a, p) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]);
};
const result = { when: new Date().toISOString(), dist: DIST, drivers: DRIVERS, steps: {} };
for (const [name, rate] of plan) {
  const m = M[name];
  if (!m) continue;
  let first = [];
  let none = 0;
  if (m.trips.length) {
    const rows = await pool.query(
      `SELECT t.trip_id, t.created_at, min(o.sent_at) AS first FROM trips t LEFT JOIN offers o ON o.trip_id = t.trip_id WHERE t.trip_id = ANY($1) GROUP BY t.trip_id, t.created_at`,
      [m.trips],
    );
    for (const r of rows.rows) {
      if (r.first) first.push(new Date(r.first).getTime() - new Date(r.created_at).getTime());
      else none++;
    }
  }
  const all = Object.values(m.http).flat();
  result.steps[name] = {
    targetRps: rate,
    realRps: Math.round(m.sent / (name.startsWith("spike") ? SPIKE_SECONDS : SECONDS)),
    requests: m.sent,
    status: m.status,
    trips: m.trips.length,
    tripsWithoutOffer: none,
    firstOfferMs: { p50: q(first, 50), p95: q(first, 95), max: q(first, 100) },
    httpMs: { p50: q(all, 50), p95: q(all, 95) },
    perEndpointP95: Object.fromEntries(Object.entries(m.http).map(([k, v]) => [k, q(v, 95)])),
    timersOverdueMax: m.overdue.length ? Math.max(...m.overdue) : 0,
    offerFeedMs: { p50: q(m.feed, 50), p95: q(m.feed, 95) },
  };
}
const gated = Object.entries(result.steps).filter(([n, s]) => n.startsWith("s") && s.targetRps <= 200);
result.pass = gated.length > 0 && gated.every(([, s]) => s.firstOfferMs.p95 !== null && s.firstOfferMs.p95 < TARGET_MS && s.tripsWithoutOffer === 0);
console.log(JSON.stringify(result, null, 2));
if (OUT) fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
server.kill("SIGTERM");
await sleep(1000);
if (serverErr && process.env.LOADTEST_SHOW_STDERR) console.error(serverErr);
await db.destroy();
if (!KEEP) await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
await admin.end();
process.exit(result.pass ? 0 : 1);
