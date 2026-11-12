/* global process, console, performance, URL */
// Global plan step 61 (T2) "Data generator for a real-size database": an empty database passes load tests falsely, so
// this fills a PRIVATE local test copy with a real-size, realistic spread of rows.
//
//   DATAGEN_ADMIN_URL="postgres://movera:movera@127.0.0.1:5432/movera" \
//   node tools/datagen/datagen.mjs --db movera_loadtest_data --scale 1 --seed 61 --create --template movera_test_template \
//        [--months 6] [--trips-per-rider 100] [--end 2026-11-01T00:00:00Z] [--workers 4] [--with-triggers] [--out r.json]
//        [--i-know-this-drops movera_loadtest_data]
//
// Scale 1 = 10k riders + 10k drivers (owner Rule 33 peak), 100 finished trips per rider over --months (≈ 1M trips), trip
// events, chat messages, payments (earnings, wallet entries, rider wallets), support tickets + messages, admin audit
// rows, fleets and vehicles, in Stockholm Z001 (SEK), Paris FR-PC (EUR) and Greater Tunis TN-TC (TND, 3 decimals).
// The spread is DISTRIBUTION in plan.mjs. Same --seed + same options = the same rows.
//
// Guards (the load tool's, tools/loadtest/guards.mjs) run before any database is touched and exit 2 with
// "LOADTEST GUARD: …": local / *.test host only (or exactly MOVERA_LOADTEST_ALLOW_HOST), --db must be
// movera_loadtest_<name>; an existing database is dropped only with --i-know-this-drops <that exact name>; --scale is
// capped (plan.mjs MAX_SCALE) unless --unsafe-max; printed text is redacted. Without --create the target must already
// exist, carry exactly the migrations in migrations/, and have no riders / drivers / trips yet.
//
// Speed: multi-row INSERT … SELECT FROM unnest(…) batches, several connections. By default (superuser) the load runs
// with session_replication_role = replica so the admin live-feed triggers do not write one live event + NOTIFY per row;
// that also skips FK triggers, so EVERY foreign key of the database is re-checked afterwards (orphans → exit 1).
// --with-triggers keeps every trigger and FK live during the load (slower).
import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import { checkTarget, dropAllowed, LoadtestGuardError, redact } from "../loadtest/guards.mjs";
import { DISTRIBUTION as D, pick, planCounts, prng, streamSeed, toMinor } from "./plan.mjs";

process.on("uncaughtException", (e) => {
  console.error(redact(e instanceof LoadtestGuardError ? e.message : (e?.stack ?? String(e))));
  process.exit(e instanceof LoadtestGuardError ? 2 : 1);
});

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};
const flag = (name) => argv.includes(`--${name}`);

/* ------------------------------------------------------------------ guards (before any I/O) */
const ADMIN_URL = process.env.DATAGEN_ADMIN_URL ?? process.env.LOADTEST_ADMIN_URL;
const DB = arg("db", "");
checkTarget(ADMIN_URL, DB, process.env); // local / test host + movera_loadtest_<name>
const MAY_DROP = dropAllowed(argv, DB);
let PLAN;
try {
  PLAN = planCounts({ scale: arg("scale"), tripsPerRider: arg("trips-per-rider", "100"), months: arg("months", "6"), unsafeMax: flag("unsafe-max") });
} catch (e) {
  throw new LoadtestGuardError(e.message);
}
const SEED = Number(arg("seed", "61"));
if (!Number.isInteger(SEED) || SEED < 0) throw new LoadtestGuardError("--seed must be a whole number ≥ 0");
const END = new Date(arg("end", "2026-11-01T00:00:00Z"));
if (Number.isNaN(END.getTime())) throw new LoadtestGuardError("--end must be an ISO date");
const START = new Date(END.getTime());
START.setUTCMonth(START.getUTCMonth() - PLAN.months);
const WORKERS = Math.min(8, Math.max(1, Number(arg("workers", "4")) | 0));
const TEMPLATE = arg("template", "");
if (TEMPLATE && !/^(movera_test_template\w*|movera_t_\w+|movera_loadtest_\w+)$/.test(TEMPLATE)) throw new LoadtestGuardError("--template must be a test template (movera_test_template*, movera_t_*, movera_loadtest_*), never a dev or real database");
const CREATE = flag("create");
const WITH_TRIGGERS = flag("with-triggers");
const OUT = arg("out", "");
const MIGRATIONS_DIR = path.join(import.meta.dirname, "..", "..", "migrations");
const urlFor = (db) => {
  const u = new URL(ADMIN_URL);
  u.pathname = `/${db}`;
  return u.toString();
};
const log = (...a) => console.log(redact(a.join(" ")));

/* ------------------------------------------------------------------ target database */
const t0 = performance.now();
const admin = new pg.Client({ connectionString: ADMIN_URL });
await admin.connect();
const exists = (await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [DB])).rowCount > 0;
if (CREATE) {
  if (exists && !MAY_DROP) {
    await admin.end();
    throw new LoadtestGuardError(`database "${DB}" exists; pass --i-know-this-drops ${DB} to drop and recreate it`);
  }
  if (exists) await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  await admin.query(TEMPLATE ? `CREATE DATABASE ${DB} TEMPLATE ${TEMPLATE}` : `CREATE DATABASE ${DB}`);
} else if (!exists) {
  await admin.end();
  throw new LoadtestGuardError(`database "${DB}" does not exist; pass --create (with --template <migrated db>)`);
}
const superuser = (await admin.query("SELECT rolsuper FROM pg_roles WHERE rolname = current_user")).rows[0]?.rolsuper === true;
await admin.end();
const REPLICA = !WITH_TRIGGERS && superuser;
if (!WITH_TRIGGERS && !superuser) log("not a superuser: loading with every trigger live (slower)");
const pool = new pg.Pool({ connectionString: urlFor(DB), max: WORKERS + 1, options: `-c synchronous_commit=off${REPLICA ? " -c session_replication_role=replica" : ""}` });
{
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => /^\d{4}_.*\.sql$/.test(f)).map((f) => f.replace(/\.sql$/, "")).sort();
  let applied = [];
  try {
    applied = (await pool.query("SELECT name FROM schema_migrations ORDER BY name")).rows.map((r) => r.name.replace(/\.sql$/, ""));
  } catch {
    applied = [];
  }
  if (applied.join(",") !== files.join(",")) {
    await pool.end();
    throw new LoadtestGuardError(`"${DB}" is not freshly migrated (${applied.length} of ${files.length} migrations); use --create --template <a migrated test db>`);
  }
  const used = (await pool.query("SELECT (SELECT count(*) FROM riders) + (SELECT count(*) FROM drivers) + (SELECT count(*) FROM trips) AS n")).rows[0].n;
  if (Number(used) > 0) {
    await pool.end();
    throw new LoadtestGuardError(`"${DB}" already has riders / drivers / trips; recreate it with --create --i-know-this-drops ${DB}`);
  }
}

/* ------------------------------------------------------------------ batched insert */
const counts = {};
/** INSERT INTO table (cols) SELECT casts FROM unnest($1::text[], …): one statement per batch, every value as text. */
async function insert(client, table, cols, rows) {
  if (rows.length === 0) return;
  const names = Object.keys(cols);
  const params = names.map((_, j) => rows.map((r) => {
    const v = r[j];
    return v === null || v === undefined ? null : typeof v === "object" && !(v instanceof Date) ? JSON.stringify(v) : v instanceof Date ? v.toISOString() : String(v);
  }));
  const text = `INSERT INTO ${table} (${names.join(", ")}) SELECT ${names.map((n) => `u.${n}::${cols[n]}`).join(", ")} FROM unnest(${names.map((_, j) => `$${j + 1}::text[]`).join(", ")}) AS u(${names.join(", ")})`;
  await client.query(text, params);
  counts[table] = (counts[table] ?? 0) + rows.length;
}
async function insertBatched(table, cols, rows, size = 5000) {
  const client = await pool.connect();
  try {
    for (let i = 0; i < rows.length; i += size) await insert(client, table, cols, rows.slice(i, i + size));
  } finally {
    client.release();
  }
}

/* ------------------------------------------------------------------ helpers */
const pad = (n, w = 8) => String(n).padStart(w, "0");
const FIRST = { SE: ["Erik", "Anna", "Lars", "Maja", "Johan", "Elsa", "Karl", "Sara", "Nils", "Ida"], FR: ["Lucas", "Emma", "Hugo", "Léa", "Louis", "Chloé", "Jules", "Manon", "Adam", "Inès"], TN: ["Mohamed", "Yasmine", "Ahmed", "Mariem", "Youssef", "Amira", "Ali", "Salma", "Omar", "Nour"] };
const LAST = { SE: ["Andersson", "Johansson", "Karlsson", "Nilsson"], FR: ["Martin", "Bernard", "Dubois", "Moreau"], TN: ["Ben Ali", "Trabelsi", "Gharbi", "Jaziri"] };
const LANG = { SE: "sv", FR: "fr", TN: "fr" };
const MAKES = [["Toyota", "Prius"], ["Volvo", "XC60"], ["Tesla", "Model 3"], ["Peugeot", "508"], ["Renault", "Megane"], ["Kia", "Niro"], ["Hyundai", "Ioniq"], ["Skoda", "Octavia"]];
const COLORS = ["black", "white", "silver", "grey", "blue", "red"];
const FUEL = ["petrol", "diesel", "hybrid", "electric"];
const CODE_ALPHA = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // fleets.code ^MV-[A-Z2-9]{5}$
const fleetCode = (n) => {
  let s = "";
  for (let i = 0; i < 5; i++, n = Math.floor(n / 32)) s = CODE_ALPHA[n % 32] + s;
  return `MV-${s}`;
};
const zoneOf = (rand) => {
  const r = rand();
  let acc = 0;
  for (const z of D.zones) if (r < (acc += z.share)) return z;
  return D.zones[D.zones.length - 1];
};
const phoneFor = (z, n) => `${z.phone}${pad(n, z.phoneDigits)}`;
const point = (rand, z, label) => ({ lat: +(z.lat + (rand() * 2 - 1) * z.dLat).toFixed(6), lng: +(z.lng + (rand() * 2 - 1) * z.dLng).toFixed(6), address: label });
// Busy hours (local): morning and evening peaks; the three zones are UTC+1 in winter (close enough for a spread).
const HOUR_W = [1, 0.6, 0.4, 0.3, 0.3, 0.6, 1.5, 3, 4, 3, 2.2, 2.2, 2.5, 2.4, 2.3, 2.6, 3.4, 4.2, 4, 3.2, 2.6, 2.2, 1.8, 1.3];
const HOUR_SUM = HOUR_W.reduce((a, b) => a + b, 0);
const SPAN_DAYS = Math.max(1, Math.floor((END.getTime() - START.getTime()) / 86_400_000));
function tripTime(rand) {
  let r = rand() * HOUR_SUM;
  let h = 0;
  while (h < 23 && (r -= HOUR_W[h]) >= 0) h++;
  const day = Math.floor(rand() * SPAN_DAYS);
  const ms = START.getTime() + day * 86_400_000 + ((h + 23) % 24) * 3_600_000 + Math.floor(rand() * 3_600_000);
  return new Date(Math.min(ms, END.getTime() - 4 * 3_600_000));
}
const plus = (d, sec) => new Date(d.getTime() + sec * 1000);

/* ------------------------------------------------------------------ people: admins, riders, drivers, fleets, vehicles */
const ROLES = ["super", "ops", "support", "support", "support", "dispatcher", "finance", "compliance", "safety", "fleet", "viewer", "config", "content"];
const admins = [];
for (let i = 0; i < PLAN.admins; i++) {
  const id = `adm_dg_${pad(i, 3)}`;
  admins.push([id, `datagen-admin-${i}@movera.test`, `Admin ${i}`, ROLES[i % ROLES.length], `Admin${i}`]);
}
await insertBatched("admins", { admin_id: "text", email: "text", name: "text", role: "text", first_name: "text" }, admins);
const supportAdmins = admins.filter((a) => a[3] === "support" || a[3] === "super").map((a) => a[0]);

const R = prng(streamSeed(SEED, "riders"));
const riderZone = []; // index → zone
const riderRows = [];
const ridersByZone = new Map(D.zones.map((z) => [z.zoneId, []]));
for (let i = 0; i < PLAN.riders; i++) {
  const z = zoneOf(R);
  riderZone.push(z);
  ridersByZone.get(z.zoneId).push(i);
  const created = new Date(START.getTime() - Math.floor(R() * 365 * 86_400_000));
  riderRows.push([`rdr_dg_${pad(i)}`, phoneFor(z, i), FIRST[z.country][i % 10], R() < 0.6 ? `rider${i}@movera.test` : null, R() < 0.995 ? "active" : "suspended", LANG[z.country], created, created, z.zoneId]);
}
await insertBatched("riders", { rider_id: "text", phone: "text", first_name: "text", email: "text", status: "text", language: "text", created_at: "timestamptz", updated_at: "timestamptz", last_seen_zone_id: "text" }, riderRows);

const DR = prng(streamSeed(SEED, "drivers"));
const driverZone = [];
const driverStatus = [];
const driverRows = [];
for (let i = 0; i < PLAN.drivers; i++) {
  const z = zoneOf(DR);
  driverZone.push(z);
  const status = pick(DR, D.driverAccount);
  driverStatus.push(status);
  const created = new Date(START.getTime() - Math.floor(DR() * 365 * 86_400_000));
  const cats = DR() < 0.3 ? "{economy,comfort}" : DR() < 0.1 ? "{economy,comfort,premium,xl}" : "{economy}";
  driverRows.push([`drv_dg_${pad(i)}`, phoneFor(z, 50_000_000 + i).slice(0, z.phone.length + z.phoneDigits), FIRST[z.country][(i * 7) % 10], LAST[z.country][i % 4], status, `{${z.zoneId}}`, cats, z.country, LANG[z.country], "driver", created, created, status === "active" ? created : null]);
}
// Driver phones must not collide with riders: drivers use the top half of the number range.
for (let i = 0; i < driverRows.length; i++) {
  const z = driverZone[i];
  driverRows[i][1] = `${z.phone}${String(10 ** z.phoneDigits - 1 - i).padStart(z.phoneDigits, "0")}`;
}
await insertBatched("drivers", { driver_id: "text", phone: "text", first_name: "text", last_name: "text", account_status: "text", zone_ids: "text[]", category_ids: "text[]", country: "bpchar", language: "text", account_type: "text", created_at: "timestamptz", updated_at: "timestamptz", first_activated_at: "timestamptz" }, driverRows);

// Fleets: owners are drivers (account_type fleet); about 30 % of the other drivers of the same zone drive for a fleet.
const F = prng(streamSeed(SEED, "fleets"));
const fleetRows = [];
const fleetOfDriver = new Array(PLAN.drivers).fill(null);
const fleetsByZone = new Map(D.zones.map((z) => [z.zoneId, []]));
for (let f = 0; f < PLAN.fleets; f++) {
  const owner = Math.floor((f * PLAN.drivers) / PLAN.fleets);
  const z = driverZone[owner];
  const id = `flt_dg_${pad(f, 5)}`;
  fleetOfDriver[owner] = id;
  fleetsByZone.get(z.zoneId).push(id);
  const status = F() < 0.9 ? "approved" : F() < 0.5 ? "pending" : "blocked";
  fleetRows.push([id, `Fleet ${f} AB`, `ORG${pad(f, 7)}`, `${z.country} street ${f}`, z.country, z.zoneId, z.zoneId, `drv_dg_${pad(owner)}`, status, fleetCode(f + 1)]);
  driverRows[owner][9] = "fleet";
}
await insertBatched("fleets", { fleet_id: "text", name: "text", org_number: "text", address: "text", country: "bpchar", city_id: "text", zone_id: "text", owner_driver_id: "text", status: "text", code: "text" }, fleetRows);
for (let i = 0; i < PLAN.drivers; i++) {
  const list = fleetsByZone.get(driverZone[i].zoneId);
  if (fleetOfDriver[i] === null && list.length > 0 && F() < D.fleetMemberShare) fleetOfDriver[i] = list[Math.floor(F() * list.length)];
}
const V = prng(streamSeed(SEED, "vehicles"));
const vehicleRows = [];
for (let i = 0; i < PLAN.drivers; i++) {
  const [make, model] = MAKES[Math.floor(V() * MAKES.length)];
  const vStatus = driverStatus[i] === "active" ? "approved" : V() < 0.5 ? "pending" : "approved";
  vehicleRows.push([`veh_dg_${pad(i)}`, `drv_dg_${pad(i)}`, make, model, 2015 + Math.floor(V() * 11), COLORS[Math.floor(V() * COLORS.length)], `DG${i.toString(36).toUpperCase().padStart(5, "0")}`, driverRows[i][6] === "{economy,comfort,premium,xl}" ? 6 : 4, driverRows[i][6], vStatus, fleetOfDriver[i], FUEL[Math.floor(V() * 4)]]);
}
await insertBatched("vehicles", { vehicle_id: "text", driver_id: "text", make: "text", model: "text", year: "int", color: "text", plate: "text", seats: "int", category_ids: "text[]", status: "text", fleet_id: "text", fuel: "text" }, vehicleRows);
{
  const client = await pool.connect();
  try {
    const ids = driverRows.map((r) => r[0]);
    for (let i = 0; i < ids.length; i += 5000) {
      const slice = ids.slice(i, i + 5000);
      await client.query(
        "UPDATE drivers d SET vehicle_id = 'veh_' || substr(u.id, 5), fleet_id = u.fleet, account_type = u.kind, fleet_linked_at = CASE WHEN u.fleet IS NULL THEN NULL ELSE d.created_at END FROM unnest($1::text[], $2::text[], $3::text[]) AS u(id, fleet, kind) WHERE d.driver_id = u.id",
        [slice, slice.map((_, j) => fleetOfDriver[i + j]), slice.map((_, j) => driverRows[i + j][9])],
      );
    }
  } finally {
    client.release();
  }
}
log(`people done: ${PLAN.riders} riders, ${PLAN.drivers} drivers, ${PLAN.fleets} fleets (${((performance.now() - t0) / 1000).toFixed(1)} s)`);

/* ------------------------------------------------------------------ trips + everything that hangs off a trip */
const driversByZone = new Map(D.zones.map((z) => [z.zoneId, []]));
for (let i = 0; i < PLAN.drivers; i++) if (driverStatus[i] === "active") driversByZone.get(driverZone[i].zoneId).push(i);
for (const z of D.zones) if (driversByZone.get(z.zoneId).length === 0) driversByZone.get(z.zoneId).push(...[...Array(PLAN.drivers).keys()].filter((i) => driverZone[i].zoneId === z.zoneId).slice(0, 1));
const walletCharged = new Array(PLAN.riders).fill(0);

const TRIP_COLS = {
  trip_id: "text", rider_id: "text", driver_id: "text", vehicle_id: "text", zone_id: "text", kind: "text", category_id: "text", status: "text", version: "int", sequence: "bigint",
  scheduled_at: "timestamptz", accepted_at: "timestamptz", search_started_at: "timestamptz", pickup: "jsonb", dropoff: "jsonb", currency: "bpchar", fare_minor: "bigint", fare_lines: "jsonb",
  booked_fare_minor: "bigint", driver_earnings_minor: "bigint", commission_minor: "bigint", payment_method: "text", payment_status: "text", rating_status: "text", driver_rating_status: "text",
  cancellation: "jsonb", created_at: "timestamptz", updated_at: "timestamptz", distance_meters: "int", duration_seconds: "int", surge_multiplier: "numeric", arrived_at: "timestamptz",
  boarded_at: "timestamptz", started_at: "timestamptz", ended_at: "timestamptz", cash_collected_minor: "bigint", wallet_applied_minor: "bigint", tip: "jsonb",
};
const EVENT_COLS = { trip_id: "text", sequence: "bigint", event_id: "text", kind: "text", version: "int", occurred_at: "timestamptz", projection: "jsonb", location: "jsonb", eta_seconds: "int", cancel_fee: "jsonb", message: "jsonb" };
const MSG_COLS = { message_id: "text", trip_id: "text", sequence: "bigint", sender: "text", sender_id: "text", text: "text", created_at: "timestamptz" };
const EARN_COLS = { entry_id: "text", driver_id: "text", trip_id: "text", kind: "text", currency: "bpchar", amount_minor: "bigint", gross_minor: "bigint", commission_minor: "bigint", cash_minor: "bigint", at: "timestamptz" };
const WALLET_COLS = { entry_id: "text", rider_id: "text", kind: "text", currency: "bpchar", amount_minor: "bigint", trip_id: "text", at: "timestamptz" };
const TICKET_COLS = { ticket_id: "text", opened_by: "text", rider_id: "text", driver_id: "text", trip_id: "text", zone_id: "text", category: "text", subject: "text", status: "text", priority: "text", created_at: "timestamptz", updated_at: "timestamptz", last_message_at: "timestamptz", visible_to_person: "boolean", assigned_admin_id: "text", solved_by: "text", solved_at: "timestamptz", first_reply_at: "timestamptz", country: "text" };
const TMSG_COLS = { message_id: "text", ticket_id: "text", sender: "text", admin_id: "text", text: "text", at: "timestamptz" };
const AUDIT_COLS = { admin_id: "text", action: "text", target_type: "text", target_id: "text", zone_id: "text", detail: "jsonb", at: "timestamptz" };
const CHAT = { rider: ["I'm at the main entrance.", "Can you wait 2 minutes?", "I see you, coming now.", "Thanks!"], driver: ["I'm here, black car outside.", "Traffic, 3 minutes.", "Where exactly are you?", "On my way."] };
const TICKET_CATS = ["ride_dispute", "help", "lost_item", "payment", "account", "safety", "other"];
const AUDIT_ACTIONS = ["trip.note", "trip.cancel", "trip.receipt_resend", "trip.reveal_contact", "trip.driver_pay", "trip.case", "trip.reassign", "trip.no_show"];
const TICKET_STATUS = { closed: 0.55, resolved: 0.25, pending: 0.1, open: 0.1 };
const CANCEL_KIND = { cancelled_by_rider: "rider_cancelled", cancelled_by_driver: "driver_cancelled" };

/** Builds one trip with its events, chat, money rows, maybe a ticket and audit rows. `out` collects rows per table. */
function buildTrip(rand, idx, status, out, opts = {}) {
  const riderIdx = opts.rider ?? (() => {
    // A rider of a zone picked by the zone share; riders keep to their zone.
    const z = zoneOf(rand);
    const list = ridersByZone.get(z.zoneId);
    return list.length ? list[Math.floor(rand() * list.length)] : Math.floor(rand() * PLAN.riders);
  })();
  const z = riderZone[riderIdx];
  const tripId = `trp_dg_${pad(idx)}`;
  const riderId = `rdr_dg_${pad(riderIdx)}`;
  const zDrivers = driversByZone.get(z.zoneId);
  const hasDriver = !["expired", "cancelled_by_system", "failed", "searching", "requested"].includes(status) && !(status === "cancelled_by_rider" && rand() < 0.4);
  const driverIdx = hasDriver ? (opts.driver ?? zDrivers[Math.floor(rand() * zDrivers.length)]) : null;
  const driverId = driverIdx === null ? null : `drv_dg_${pad(driverIdx)}`;
  const created = opts.at ?? tripTime(rand);
  const category = pick(rand, D.categories);
  const km = 1 + rand() * rand() * 35;
  const surge = rand() < 0.12 ? +(1.1 + rand() * 0.8).toFixed(2) : 1;
  const fare = toMinor(z, (z.base + z.perKm * km) * surge);
  let method = pick(rand, D.paymentMethod);
  if (z.country === "TN" && method !== "cash" && rand() < 0.45) method = "cash";
  const commission = toMinor(z, (fare / 10 ** z.digits) * 0.25);
  const durationSec = Math.round((km * 1000) / (6 + rand() * 6));
  const accepted = driverId ? plus(created, 10 + Math.floor(rand() * 110)) : null;
  const arrived = accepted ? plus(accepted, 120 + Math.floor(rand() * 600)) : null;
  const started = arrived ? plus(arrived, 30 + Math.floor(rand() * 240)) : null;
  const ended = started ? plus(started, durationSec) : null;
  const done = status === "completed";
  const pickup = point(rand, z, "Pickup");
  const dropoff = point(rand, z, "Dropoff");
  const events = [];
  let version = 1;
  const proj = (s, at) => events.push(["trip_projection", ++version, at, { status: s, version }, null, null]);
  const loc = (at, n) => {
    for (let k = 0; k < n; k++) events.push(["location", version, plus(at, 15 * (k + 1)), null, { lat: pickup.lat + (rand() - 0.5) * 0.01, lng: pickup.lng + (rand() - 0.5) * 0.01, heading: Math.floor(rand() * 360) }, null]);
  };
  events.push(["trip_projection", version, created, { status: "searching", version }, null, null]);
  let lastAt = created;
  let cancellation = null;
  const STAGE = ["searching", "accepted", "driver_to_pickup", "arrived", "rider_onboard", "in_trip", "approaching_dropoff", "completed"];
  const reach = done ? 7 : STAGE.indexOf(status) >= 0 ? STAGE.indexOf(status) : status === "no_show" ? 3 : driverId ? (rand() < 0.5 ? 1 : 2) : 0;
  if (reach >= 1) proj("accepted", (lastAt = accepted));
  if (reach >= 2) {
    proj("driver_to_pickup", plus(accepted, 5));
    loc(accepted, 1 + Math.floor(rand() * 4));
    lastAt = plus(accepted, 80);
  }
  if (reach >= 3) {
    events.push(["driver_arrived", version, arrived, null, null, null]);
    proj("arrived", (lastAt = arrived));
  }
  if (reach >= 5) {
    proj("in_trip", started);
    loc(started, 1 + Math.floor(rand() * 4));
    lastAt = plus(started, 80);
  }
  if (done) {
    proj("completed", (lastAt = ended));
    events.push(["payment_updated", version, plus(ended, 2), null, null, null]);
  } else if (STAGE.indexOf(status) < 0) {
    const at = (lastAt = plus(lastAt, 30 + Math.floor(rand() * 300)));
    const reason = status === "no_show" ? "rider_no_show" : status === "expired" ? "no_driver_found" : status.replace("cancelled_by_", "by_");
    cancellation = { by: status.replace("cancelled_by_", ""), reason, at: at.toISOString() };
    if (CANCEL_KIND[status]) events.push([CANCEL_KIND[status], version, at, null, null, null]);
    proj(status, at);
  }
  const rated = done && rand() < 0.7;
  if (rated) events.push(["rating_updated", version, plus(ended, 120), null, null, null]);
  // chat
  const msgs = [];
  if (driverId && reach >= 1 && rand() < D.chatTripShare) {
    const n = 1 + Math.floor(rand() * 5);
    for (let k = 0; k < n; k++) {
      const sender = k % 2 === 0 ? "rider" : "driver";
      const at = plus(accepted, 20 + k * 40);
      const text = CHAT[sender][Math.floor(rand() * 4)];
      msgs.push([`msg_dg_${pad(idx)}_${k + 1}`, tripId, k + 1, sender, sender === "rider" ? riderId : driverId, text, at]);
      events.push(["message", version, at, null, null, { messageId: `msg_dg_${pad(idx)}_${k + 1}`, sender, text }]);
    }
  }
  events.sort((a, b) => a[2] - b[2]);
  events.forEach((e, k) => out.trip_events.push([tripId, k + 1, `evt_dg_${pad(idx)}_${k + 1}`, e[0], e[1], e[2], e[3], e[4], e[0] === "location" ? 60 + Math.floor(rand() * 600) : null, null, e[5]]));
  out.trip_messages.push(...msgs);
  // money
  let paymentStatus = null;
  if (done) paymentStatus = method === "cash" ? "captured" : rand() < 0.02 ? "failed" : rand() < 0.01 ? "refunded" : "captured";
  else if (["accepted", "driver_to_pickup", "arrived", "in_trip"].includes(status) && method !== "cash") paymentStatus = "authorized";
  const tip = done && rand() < D.tipShare ? toMinor(z, (fare / 10 ** z.digits) * 0.1) : 0;
  if (done && driverId) {
    out.earnings_entries.push([`ern_dg_${pad(idx)}_t`, driverId, tripId, "trip", z.currency, fare - commission, fare, commission, method === "cash" ? fare : 0, plus(ended, 1)]);
    if (tip) out.earnings_entries.push([`ern_dg_${pad(idx)}_p`, driverId, tripId, "tip", z.currency, tip, null, null, 0, plus(ended, 200)]);
  }
  if (done && method === "wallet") {
    out.wallet_entries.push([`wlt_dg_${pad(idx)}_c`, riderId, "charge", z.currency, -fare, tripId, plus(ended, 1)]);
    walletCharged[riderIdx] += fare;
  }
  const scheduled = opts.scheduledAt ?? null;
  out.trips.push([
    tripId, riderId, driverId, driverId ? `veh_dg_${pad(driverIdx)}` : null, z.zoneId, scheduled ? "scheduled" : "live", category, status, version, events.length,
    scheduled, accepted, created, pickup, dropoff, z.currency, fare, [{ kind: "base", amountMinor: fare }], fare, done ? fare - commission : null, done ? commission : null, method, paymentStatus,
    rated ? "submitted" : done ? "skipped" : "not_requested", done ? (rand() < 0.5 ? "submitted" : "skipped") : "not_requested", cancellation, created, lastAt, Math.round(km * 1000), durationSec, surge,
    reach >= 3 ? arrived : null, reach >= 5 ? started : null, reach >= 5 ? started : null, done ? ended : null, done && method === "cash" ? fare : null, done && method === "wallet" ? fare : 0,
    tip ? { amountMinor: tip, currency: z.currency } : null,
  ]);
  // support ticket about this trip
  if (rand() < D.ticketsPerTrip) {
    const tId = `tkt_dg_${pad(idx)}`;
    const by = driverId && rand() < 0.35 ? "driver" : rand() < 0.07 ? "admin" : "rider";
    const tStatus = pick(rand, TICKET_STATUS);
    const at = plus(lastAt, 600 + Math.floor(rand() * 86_400));
    const assignee = supportAdmins[Math.floor(rand() * supportAdmins.length)];
    const solved = tStatus === "resolved" || tStatus === "closed";
    const n = 2 + Math.floor(rand() * 3);
    out.support_tickets.push([tId, by, riderId, by === "driver" ? driverId : rand() < 0.3 ? driverId : null, tripId, z.zoneId, TICKET_CATS[Math.floor(rand() * TICKET_CATS.length)], "About my ride", tStatus, rand() < 0.1 ? "high" : "normal", at, plus(at, n * 3600), plus(at, (n - 1) * 3600), true, assignee, solved ? assignee : null, solved ? plus(at, n * 3600) : null, n > 1 ? plus(at, 3600) : null, z.country]);
    for (let k = 0; k < n; k++) {
      const support = k % 2 === 1;
      out.ticket_messages.push([`tmsg_dg_${pad(idx)}_${k + 1}`, tId, support ? "support" : by === "driver" ? "driver" : "rider", support ? assignee : null, support ? "Thanks, we are looking into it." : "Please help with this ride.", plus(at, k * 3600)]);
    }
  }
  if (rand() < D.auditPerTrip) {
    out.admin_audit.push([admins[Math.floor(rand() * admins.length)][0], AUDIT_ACTIONS[Math.floor(rand() * AUDIT_ACTIONS.length)], "trip", tripId, z.zoneId, { source: "datagen" }, plus(lastAt, 300 + Math.floor(rand() * 7200))]);
  }
}

const emptyOut = () => ({ trips: [], trip_events: [], trip_messages: [], earnings_entries: [], wallet_entries: [], support_tickets: [], ticket_messages: [], admin_audit: [] });
async function writeOut(out) {
  const client = await pool.connect();
  try {
    // Parents first, so --with-triggers (live FKs) works too.
    await insert(client, "trips", TRIP_COLS, out.trips);
    for (let i = 0; i < out.trip_events.length; i += 20_000) await insert(client, "trip_events", EVENT_COLS, out.trip_events.slice(i, i + 20_000));
    await insert(client, "trip_messages", MSG_COLS, out.trip_messages);
    await insert(client, "earnings_entries", EARN_COLS, out.earnings_entries);
    await insert(client, "wallet_entries", WALLET_COLS, out.wallet_entries);
    await insert(client, "support_tickets", TICKET_COLS, out.support_tickets);
    await insert(client, "ticket_messages", TMSG_COLS, out.ticket_messages);
    await insert(client, "admin_audit", AUDIT_COLS, out.admin_audit);
  } finally {
    client.release();
  }
}

// Finished trips in chunks: each chunk has its own seeded stream, so the rows are the same at any --workers.
const CHUNK = 4000;
const chunks = Math.ceil(PLAN.historicTrips / CHUNK);
let next = 0;
let doneChunks = 0;
async function worker() {
  for (;;) {
    const c = next++;
    if (c >= chunks) return;
    const rand = prng(streamSeed(SEED, "trips", c));
    const out = emptyOut();
    for (let i = c * CHUNK; i < Math.min(PLAN.historicTrips, (c + 1) * CHUNK); i++) buildTrip(rand, i, pick(rand, D.tripStatus), out);
    await writeOut(out);
    if (++doneChunks % 25 === 0) log(`trips ${doneChunks}/${chunks} chunks (${((performance.now() - t0) / 1000).toFixed(1)} s)`);
  }
}
await Promise.all(Array.from({ length: WORKERS }, worker));

// Active trips now (each with its own rider + driver: the one-live-trip indexes) and booked rides in the next 14 days.
{
  const rand = prng(streamSeed(SEED, "active"));
  const out = emptyOut();
  let idx = PLAN.historicTrips;
  const usedDrivers = new Set();
  const riderStep = Math.max(1, Math.floor(PLAN.riders / Math.max(1, PLAN.activeTrips)));
  for (let k = 0; k < PLAN.activeTrips; k++) {
    const riderIdx = (k * riderStep) % PLAN.riders;
    const zDrivers = driversByZone.get(riderZone[riderIdx].zoneId);
    let driverIdx = zDrivers[Math.floor(rand() * zDrivers.length)];
    for (let tries = 0; usedDrivers.has(driverIdx) && tries < zDrivers.length; tries++) driverIdx = zDrivers[(zDrivers.indexOf(driverIdx) + 1) % zDrivers.length];
    const status = pick(rand, D.activeStatus);
    if (status !== "searching" && usedDrivers.has(driverIdx)) continue;
    if (status !== "searching") usedDrivers.add(driverIdx);
    buildTrip(rand, idx++, status, out, { rider: riderIdx, driver: driverIdx, at: new Date(END.getTime() - Math.floor(rand() * 1_200_000)) });
  }
  for (let k = 0; k < PLAN.bookedRides; k++) {
    const at = new Date(END.getTime() - Math.floor(rand() * 3 * 86_400_000));
    buildTrip(rand, idx++, "requested", out, { at, scheduledAt: new Date(END.getTime() + Math.floor(rand() * 14 * 86_400_000)) });
  }
  await writeOut(out);
  const busy = [...usedDrivers].map((i) => `drv_dg_${pad(i)}`);
  await pool.query("UPDATE drivers SET online_status = 'on_trip', online_since = $2 WHERE driver_id = ANY($1::text[])", [busy, new Date(END.getTime() - 3_600_000)]);
  PLAN.activeTripsWritten = out.trips.length - PLAN.bookedRides;
}

// Wallets: every rider gets a wallet in the zone currency; top-ups cover the wallet charges plus a left-over balance.
{
  const rand = prng(streamSeed(SEED, "wallets"));
  const wallets = [];
  const entries = [];
  const riderMoney = [];
  for (let i = 0; i < PLAN.riders; i++) {
    const z = riderZone[i];
    const left = rand() < 0.3 ? toMinor(z, rand() * 20 * (z.currency === "SEK" ? 10 : 1)) : 0;
    const topup = walletCharged[i] + left;
    if (topup > 0) entries.push([`wlt_dg_r${pad(i)}_t`, `rdr_dg_${pad(i)}`, "topup", z.currency, topup, null, START]);
    wallets.push([`rdr_dg_${pad(i)}`, z.currency, left, END]);
    riderMoney.push(left);
  }
  await insertBatched("wallet_entries", WALLET_COLS, entries);
  await insertBatched("rider_wallets", { rider_id: "text", currency: "text", balance_minor: "bigint", updated_at: "timestamptz" }, wallets);
  const ids = wallets.map((w) => w[0]);
  for (let i = 0; i < ids.length; i += 5000) {
    await pool.query("UPDATE riders r SET wallet_minor = u.m FROM unnest($1::text[], $2::bigint[]) AS u(id, m) WHERE r.rider_id = u.id AND u.m > 0", [ids.slice(i, i + 5000), riderMoney.slice(i, i + 5000)]);
  }
}
// Rating totals on people, from the trips just written.
await pool.query("UPDATE drivers d SET rating_count = s.n, rating_sum = s.n * 5 - s.n / 7 FROM (SELECT driver_id, count(*)::int AS n FROM trips WHERE rating_status = 'submitted' GROUP BY driver_id) s WHERE d.driver_id = s.driver_id");
const loadSeconds = (performance.now() - t0) / 1000;

/* ------------------------------------------------------------------ foreign keys re-checked (replica mode skipped them) */
const fkRows = (
  await pool.query(`
    SELECT c.conname, c.conrelid::regclass::text AS child, c.confrelid::regclass::text AS parent,
           array_agg(a.attname::text ORDER BY k.n) AS ccols, array_agg(af.attname::text ORDER BY k.n) AS pcols
      FROM pg_constraint c
      CROSS JOIN LATERAL unnest(c.conkey, c.confkey) WITH ORDINALITY AS k(ck, pk, n)
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.ck
      JOIN pg_attribute af ON af.attrelid = c.confrelid AND af.attnum = k.pk
     WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace
     GROUP BY c.conname, c.conrelid, c.confrelid`)
).rows;
const orphans = {};
for (const fk of fkRows) {
  const notNull = fk.ccols.map((c) => `c.${c} IS NOT NULL`).join(" AND ");
  const match = fk.ccols.map((c, i) => `p.${fk.pcols[i]} = c.${c}`).join(" AND ");
  const n = Number((await pool.query(`SELECT count(*) AS n FROM ${fk.child} c WHERE ${notNull} AND NOT EXISTS (SELECT 1 FROM ${fk.parent} p WHERE ${match})`)).rows[0].n);
  if (n > 0) orphans[fk.conname] = n;
}
await pool.query("ANALYZE");
const result = {
  db: DB,
  seed: SEED,
  plan: PLAN,
  range: { start: START.toISOString(), end: END.toISOString() },
  mode: REPLICA ? "replica (triggers off, FKs re-checked)" : "triggers on",
  rows: counts,
  fkChecked: fkRows.length,
  orphans,
  loadSeconds: +loadSeconds.toFixed(1),
  totalSeconds: +((performance.now() - t0) / 1000).toFixed(1),
};
await pool.end();
if (OUT) fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
log(JSON.stringify(result));
if (Object.keys(orphans).length > 0) {
  console.error(`DATAGEN: ${Object.keys(orphans).length} foreign key(s) have orphan rows`);
  process.exit(1);
}
