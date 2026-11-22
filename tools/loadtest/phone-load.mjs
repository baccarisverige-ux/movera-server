/* global process, console, fetch, URL */
// Global plan step 60 (T1 part 2): load with FAKE PHONES — the load gate measures the apps, not the tool.
// PRIVATE local copy only, never a live server (guards.mjs, step 59, run first and exit 2 with "LOADTEST GUARD: …").
//
//   LOADTEST_ADMIN_URL="postgres://movera:[REDACTED]@127.0.0.1:5432/movera" npm run build && \
//   node tools/loadtest/phone-load.mjs --dist dist --db movera_loadtest_phones --drivers 100 --riders 400 \
//        --rider-arrivals 20 --seconds 600 --access-ttl 120 --zone-share Z001=0.5,FR-PC=0.3,TN-TC=0.2 \
//        --out /tmp/phones.json --i-know-this-drops movera_loadtest_phones
//
// What it does: a NEW database, migrated with the server build; the zones of --zone-share opened IN THAT COPY ONLY
// (owner TN-9a: Tunis TN-TC next to Stockholm Z001 and Paris FR-PC) and the contract sample settings published as each
// country's standard (seedSampleConfig: SEK, EUR, TND); drivers and a pool of rider accounts with +46 / +33 / +216 test
// numbers; the server build on 127.0.0.1. Then:
//   - drivers: a fixed population (share --driver-offline-share offline with Home open), each a DriverPhone;
//   - riders: an OPEN model — new riders arrive as a Poisson process of --rider-arrivals per minute, whatever the server
//     answers; each is a RiderPhone that runs Home → Choose → book → … → Receipt and leaves;
//   - every phone sends what its app sends in its state at the app's cadence (cadences.mjs, file:line per number),
//     keeps the app's streams open and reacts to their events like the app;
//   - tokens are real: the first access token lives a random part of --access-ttl, then every phone goes through a
//     real POST /auth/refresh (401 → refresh → the same request again, the same Idempotency-Key) as the apps do.
// Output: per app and state the measured requests per phone-minute next to the cadence table (pass = every state with
// enough phone-minutes within 10 %), event reactions per event, tool lag (planned → sent), latency from the planned
// time, refreshes, trips per zone and currency from the database. Exit 0 = counts within budget, 1 = not, 2 = refused.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import pg from "pg";
import { realClock, poissonArrivals, seededRandom } from "./clock.mjs";
import { cadenceRows } from "./cadences.mjs";
import { Counter, summaryLines } from "./counts.mjs";
import { checkPhoneLimits, checkTarget, dropAllowed, LoadtestGuardError, redact, serverEnv } from "./guards.mjs";
import { Auth, DriverPhone, RiderPhone } from "./phones.mjs";
import { httpTransport } from "./transport.mjs";
import { DEFAULT_SHARE, near, parseZoneShare, phoneNumber, zoneForIndex } from "./zones.mjs";

process.on("uncaughtException", (e) => {
  console.error(redact(e instanceof LoadtestGuardError ? e.message : (e?.stack ?? String(e))));
  process.exit(e instanceof LoadtestGuardError ? 2 : 1);
});
process.on("unhandledRejection", (e) => {
  console.error(redact(e instanceof LoadtestGuardError ? e.message : (e?.stack ?? String(e))));
  process.exit(e instanceof LoadtestGuardError ? 2 : 1);
});

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const DIST = path.resolve(arg("dist", "dist"));
const DB = arg("db", "movera_loadtest_phones");
const PORT = Number(arg("port", "18182"));
const OUT = arg("out", "");
const KEEP = process.argv.includes("--keep");
const ADMIN_URL = process.env.LOADTEST_ADMIN_URL;
checkTarget(ADMIN_URL, DB, process.env); // guard (a)
const MAY_DROP = dropAllowed(process.argv, DB); // guard (b)
const LIMITS = checkPhoneLimits({ drivers: arg("drivers"), riders: arg("riders"), seconds: arg("seconds"), riderArrivals: arg("rider-arrivals"), accessTtl: arg("access-ttl"), unsafeMax: process.argv.includes("--unsafe-max") }); // guard (d)
const SHARES = parseZoneShare(arg("zone-share", DEFAULT_SHARE));
const OFFLINE_SHARE = Math.min(1, Math.max(0, Number(arg("driver-offline-share", "0.2"))));
const MIN_PHONE_MINUTES = Number(arg("min-phone-minutes", "5"));
const rng = seededRandom(Number(arg("seed", "60")));
// Dwell times (ms, exponential means) of the states the phones leave on their own; JSON to override, e.g. {"home":60000}.
const RIDER_DWELL = { home: 120_000, choose: 60_000, receipt: 60_000, abandonMs: 600_000, ...JSON.parse(arg("rider-dwell", "{}")) };
const DRIVER_DWELL = { think: 3_000, toPickup: 240_000, atPickup: 60_000, onTrip: 600_000, acceptShare: 0.85, ...JSON.parse(arg("driver-dwell", "{}")) };
const urlFor = (db) => {
  const u = new URL(ADMIN_URL);
  u.pathname = `/${db}`;
  return u.toString();
};
const JWT = "load-test-secret-0123456789-abcdefghijklmnopqrstuvwxyz";
const imp = (p) => import(path.join(DIST, p));

/* ------------------------------------------------------------ database + seed */
const admin = new pg.Client({ connectionString: ADMIN_URL });
await admin.connect();
if (MAY_DROP) await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
else if ((await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [DB])).rowCount) {
  await admin.end();
  throw new LoadtestGuardError(`database "${DB}" exists; pass --i-know-this-drops ${DB} to drop and recreate it`);
}
await admin.query(`CREATE DATABASE ${DB}`);
let server = null;
let pool = null;
let db = null;
let exitCode = 1;
try {
  const { createPool, createDb } = await imp("db/db.js");
  const { migrate } = await imp("db/migrate.js");
  const { seedDriver } = await imp("drivers/service.js");
  const { startSession } = await imp("auth/service.js");
  const { signAccessToken } = await imp("auth/jwt.js");
  const { newId } = await imp("ids.js");
  const { seedSampleConfig } = await imp("config/seedConfig.js");
  pool = createPool(urlFor(DB), 5);
  await migrate(pool);
  db = createDb(pool);
  const t0 = new Date();
  // TN-TC is closed in the migrations (contract §21): opened here, in this private copy only, for the TN-9a share.
  await db.updateTable("zones").set({ open: true }).where("zone_id", "in", SHARES.map((s) => s.zoneId)).execute();
  await db.transaction().execute((trx) => seedSampleConfig(trx, t0));
  // v0.18.144 rider-sharing mode (env LOADTEST_LIVE_SHARE=1, read by cadences.mjs at load): the zone switch on in THIS private copy only (default OFF).
  if (process.env.LOADTEST_LIVE_SHARE === "1") {
    const docs = await db.selectFrom("config_live").select(["zone_id", "document"]).where("doc", "=", "rider_app_config").execute();
    for (const d of docs) await db.updateTable("config_live").set({ document: JSON.stringify({ ...d.document, liveLocation: { share: true } }) }).where("doc", "=", "rider_app_config").where("zone_id", "=", d.zone_id).execute();
  }
  const session = async (actor, subjectId, zones) => {
    const s = await db.transaction().execute((trx) => startSession(trx, { jwtSecret: JWT }, { actor, subjectId, zones }, { ip: "127.0.0.1", userAgent: "load-phone" }, t0, 24 * 3600_000));
    // The first access token expires early (20–100 % of --access-ttl) so every phone refreshes during the run.
    const ttl = Math.max(10, Math.round(LIMITS.accessTtlSeconds * (0.2 + 0.8 * rng())));
    return { access: signAccessToken({ sub: subjectId, actor, sid: s.sessionId, zones }, JWT, ttl, new Date()), refresh: s.refreshToken };
  };
  const drivers = [];
  for (let i = 0; i < LIMITS.drivers; i++) {
    const zone = zoneForIndex(SHARES, i, LIMITS.drivers);
    const made = await db.transaction().execute((trx) => seedDriver(trx, { phone: phoneNumber(zone, "driver", i), firstName: `Load ${i}`, make: "Volvo", model: "V60", year: 2022, color: "Black", plate: `LP${String(i).padStart(4, "0")}`, categoryIds: ["economy"], zoneIds: [zone.zoneId] }, t0));
    // the driver's country, as onboarding sets it (GET /driver/onboarding/settings reads it, drivers/routes.ts:70)
    await db.updateTable("drivers").set({ country: zone.country }).where("driver_id", "=", made.driverId).execute();
    drivers.push({ id: made.driverId, zone, online: rng() >= OFFLINE_SHARE, ...(await session("driver", made.driverId, [zone.zoneId])) });
  }
  const online = drivers.filter((d) => d.online).map((d) => d.id);
  if (online.length) await db.updateTable("drivers").set({ online_status: "online", online_since: t0, last_free_at: t0 }).where("driver_id", "in", online).execute();
  const riders = [];
  for (let i = 0; i < LIMITS.riders; i++) {
    const zone = zoneForIndex(SHARES, i, LIMITS.riders);
    const id = newId("rdr", t0.getTime());
    await db.insertInto("riders").values({ rider_id: id, phone: phoneNumber(zone, "rider", i), first_name: `Load r${i}`, status: "active", language: zone.language }).execute();
    riders.push({ id, zone, busy: false, ...(await session("rider", id, [])) });
  }
  console.log(`seeded ${drivers.length} drivers (${online.length} online), ${riders.length} rider accounts; zones ${SHARES.map((s) => `${s.zoneId} ${Math.round(s.share * 100)} %`).join(", ")}`);

  /* ------------------------------------------------------------ server */
  server = spawn(process.execPath, [path.join(DIST, "main.js")], {
    // guard (c): allow-listed inherited variables only
    env: serverEnv(process.env, { DATABASE_URL: urlFor(DB), PORT: String(PORT), HOST: "127.0.0.1", MOVERA_ENV: "development", JWT_SECRET: JWT, MIGRATE_ON_START: "false", LOG_LEVEL: "warn", OSRM_URL: "", FIREBASE_SERVICE_ACCOUNT: "" }),
    stdio: ["ignore", "ignore", "pipe"],
  });
  let serverErr = "";
  server.stderr.on("data", (c) => (serverErr = (serverErr + c).slice(-4000)));
  let healthy = false;
  for (let i = 0; i < 120 && !healthy; i++) {
    try {
      healthy = (await fetch(`http://127.0.0.1:${PORT}/healthz`)).ok;
    } catch {
      /* not up yet */
    }
    if (!healthy) await sleep(500);
  }
  if (!healthy) throw new Error(`the server never became healthy on 127.0.0.1:${PORT}: ${redact(serverErr)}`);

  /* ------------------------------------------------------------ phones */
  const counter = new Counter();
  const transport = httpTransport(PORT, counter);
  const phones = new Set();
  const zonesSeen = { rider: {}, driver: {} };
  const phone = (Kind, app, account, dwell) => {
    const auth = new Auth({ access: account.access, refresh: account.refresh, transport, counter, app });
    const p = new Kind({ clock: realClock, rng, counter, transport, auth, zone: account.zone, dwell });
    zonesSeen[app][account.zone.zoneId] = (zonesSeen[app][account.zone.zoneId] ?? 0) + 1;
    phones.add(p);
    return p;
  };
  for (const d of drivers) {
    const p = phone(DriverPhone, "driver", d, DRIVER_DWELL);
    p.pos = near(d.zone, rng, 0.01);
    realClock.at(Date.now() + rng() * 10_000, () => p.start(d.online));
  }
  const started = Date.now();
  const end = started + LIMITS.seconds * 1000;
  let next = 0;
  const arrivals = poissonArrivals(realClock, rng, LIMITS.riderArrivalsPerMinute, () => {
    counter.bump("rider.arrivals");
    // the arrival's zone by the shares (golden-ratio sequence: the shares hold in small runs too), then a free account
    // of that zone; none free: the arrival is lost and counted
    const zone = zoneForIndex(SHARES, Math.floor(((next++ * 0.6180339887) % 1) * 1e6), 1e6);
    const pool = riders.filter((r) => r.zone === zone);
    for (const acc of pool) {
      if (acc.busy) continue;
      acc.busy = true;
      const p = phone(RiderPhone, "rider", acc, RIDER_DWELL);
      p.onLeave = ((orig) => () => (orig?.call(p), (acc.busy = false), (acc.access = p.auth.access), (acc.refresh = p.auth.refresh), phones.delete(p)))(p.onLeave);
      p.start();
      return;
    }
    counter.bump("rider.poolExhausted");
  }, end);
  while (Date.now() < end) {
    await sleep(Math.min(30_000, end - Date.now()));
    console.log(`t+${Math.round((Date.now() - started) / 1000)} s: ${phones.size} phones, ${counter.extra["rider.arrivals"] ?? 0} arrivals, ${counter.extra["rider.booked"] ?? 0} booked, ${counter.extra["driver.completed"] ?? 0} completed`);
  }
  arrivals.stop();
  for (const p of [...phones]) p.leave();
  await sleep(2_000);

  /* ------------------------------------------------------------ results */
  const report = counter.report({ minPhoneMinutes: MIN_PHONE_MINUTES });
  const trips = await pool.query("SELECT zone_id, currency, status, count(*)::int AS n FROM trips GROUP BY 1, 2, 3 ORDER BY 1, 2, 3");
  const result = { when: new Date().toISOString(), dist: DIST, limits: LIMITS, zoneShare: SHARES, zonesSeen, riderDwell: RIDER_DWELL, driverDwell: DRIVER_DWELL, report, tripsByZone: trips.rows, cadenceTable: cadenceRows() };
  console.log(summaryLines(report).join("\n"));
  console.log(JSON.stringify({ pass: report.pass, reactions: report.reactions, extra: report.extra, status: report.status, errors: report.errors, toolLagMs: report.toolLagMs, latencyFromPlannedMs: report.latencyFromPlannedMs, zonesSeen, tripsByZone: trips.rows }, null, 2));
  if (OUT) fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  if (serverErr && process.env.LOADTEST_SHOW_STDERR) console.error(redact(serverErr));
  exitCode = report.pass ? 0 : 1;
} finally {
  // only our own child; the database is dropped only with --i-know-this-drops (and not with --keep)
  if (server && server.exitCode === null) server.kill("SIGTERM");
  await sleep(500);
  await db?.destroy().catch(() => undefined);
  if (MAY_DROP && !KEEP) await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  else console.log(`database ${DB} kept (${KEEP ? "--keep" : `drop it with --i-know-this-drops ${DB} on the next run`})`);
  await admin.end();
}
process.exit(exitCode);
