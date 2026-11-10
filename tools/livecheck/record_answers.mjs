#!/usr/bin/env node
/* global process, console, fetch, setTimeout, AbortSignal */
/**
 * Step 72 (T14, global plan V35.5): records REAL answers of the staging server for the hot app calls and stores them,
 * cleaned, under test/fixtures/recorded/<name>.json (test/fixtures/recorded.test.ts checks each against the contract).
 *   node tools/livecheck/record_answers.mjs            (MOVERA_BASE to point elsewhere; staging by default)
 * Flow = tools/livecheck/tunis_trip.mjs of server PR #149 (same API order): driver online in Tunis, rider zones,
 * rider config TN-TC, quote Avenue Habib Bourguiba → Aéroport Tunis-Carthage, book cash, driver offers, accept,
 * head → arrive → board → start → complete, trip views, events replay page, receipts. A trip left half-way is
 * cancelled and the driver goes offline at the end, so no trip stays active.
 * Never prints or stores tokens: every id is replaced by a stable fake (first seen = 1), phone numbers, e-mails,
 * tokens, names and plates by fixed placeholders.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BASE = process.env.MOVERA_BASE ?? "https://movera-server.onrender.com/api/v1";
const RIDER = process.env.REC_RIDER_PHONE ?? "+46701740609"; // a test rider NOT used by the phone runs (coordinator 2026-11-10) (contract.json#auth.testSignIn accounts)
const DRIVER = process.env.REC_DRIVER_PHONE ?? "+46701740606"; // a test driver NOT used by the phone runs
const CODE = "1234"; // contract.json#auth.testSignIn fixed code
const ZONE = "TN-TC";
const TUNIS = { lat: 36.8065, lng: 10.1815 };
const PICKUP = { address: "Avenue Habib Bourguiba, Tunis", lat: 36.8008, lng: 10.18 };
const DROPOFF = { address: "Aéroport Tunis-Carthage", lat: 36.851, lng: 10.2272 };
const OUT = join(dirname(fileURLToPath(import.meta.url)), "../../test/fixtures/recorded");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (line) => console.log(line);

async function call(method, path, token, body) {
  const headers = { "X-Api-Version": "0.5", "Accept-Language": "fr", accept: "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  if (method !== "GET") Object.assign(headers, { "content-type": "application/json", "idempotency-key": randomUUID() });
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(`${BASE}${path}`, { method, headers, ...(method !== "GET" ? { body: JSON.stringify(body ?? {}) } : {}), signal: AbortSignal.timeout(90_000) });
      const text = await res.text();
      let json = {};
      try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: "[not json]" }; }
      return { status: res.status, body: json };
    } catch (error) {
      if (attempt >= 2) return { status: 0, body: { error: String(error).slice(0, 120) } };
      await sleep(3000);
    }
  }
}

/* ---------------------------------------------------------------- cleaning */
const ids = new Map();
const ID_KEY = /(^id$|Id$|Ids$|^sequence$|Key$)/;
const SECRET_KEY = /token|secret|password|otp|code$/i;
const PERSON_KEY = /phone|email|^name$|firstName|lastName|displayName|plate|licen[cs]e|photo|avatar|url$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function fakeId(value) {
  if (!ids.has(value)) {
    const n = ids.size + 1;
    // Keeps the shape the contract checks: a uuid stays a uuid, a prefixed id keeps its prefix.
    const fake = UUID.test(value) ? `00000000-0000-4000-8000-${String(n).padStart(12, "0")}` : `${(/^[a-z]+_/i.exec(value) ?? [""])[0]}fake${String(n).padStart(4, "0")}`;
    ids.set(value, fake);
  }
  return ids.get(value);
}
const ZONE_IDS = /^(Z\d{3}|[A-Z]{2}-[A-Z]{2}|[A-Z]{3})$/; // zone ids are settings, not people: kept
function clean(value, key = "") {
  if (Array.isArray(value)) return value.map((v) => clean(v, key));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clean(v, k)]));
  if (typeof value !== "string") return value;
  if (SECRET_KEY.test(key) && !/reasonCode|reason|currency|countryCode|categoryCode|^code$/.test(key)) return "[REDACTED]";
  if (/^\+\d{7,15}$/.test(value)) return "+10000000000";
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) return "user@example.test";
  if (PERSON_KEY.test(key)) return /url$/i.test(key) ? "https://example.test/redacted" : "[REDACTED]";
  if (ID_KEY.test(key) && !ZONE_IDS.test(value) && !/^(economy|comfort|xl|premium|van|green|cash|card)$/.test(value)) return fakeId(value);
  if (UUID.test(value)) return fakeId(value);
  return value;
}
const saved = [];
function save(name, route, res) {
  mkdirSync(OUT, { recursive: true });
  const doc = { route, status: res.status, recordedAt: new Date().toISOString().slice(0, 10), server: "staging", apiVersion: "0.5", body: clean(res.body) };
  writeFileSync(join(OUT, `${name}.json`), `${JSON.stringify(doc, null, 2)}\n`);
  saved.push(`${name} (${route} → ${res.status})`);
  log(`saved  ${name}.json  ${route} → HTTP ${res.status}`);
}

/* ---------------------------------------------------------------- the trip */
async function signIn(phone, app) {
  const otp = await call("POST", "/auth/otp/request", undefined, { phone, app });
  if (otp.status >= 300) return null;
  const v = await call("POST", "/auth/otp/verify", undefined, { phone, sessionId: otp.body.sessionId, code: CODE });
  return v.status === 200 ? v.body.accessToken : null;
}
let fixAt = Date.now();
const fix = (at) => { fixAt = Math.max(Date.now(), fixAt + 1000); return { lat: at.lat, lng: at.lng, accuracy: 5, measuredAt: new Date(fixAt).toISOString() }; };
let driver; let rider; let tripId; let ended = false;
const sendFix = (at) => call("POST", "/driver/location", driver, { fixes: [fix(at)] });
async function command(path, body = {}) {
  const t = await call("GET", `/trips/${tripId}`, driver);
  return call("POST", `/trips/${tripId}/${path}`, driver, { expectedVersion: t.body.version, ...body });
}

async function main() {
  log(`record answers → ${BASE}`);
  driver = await signIn(DRIVER, "driver");
  rider = await signIn(RIDER, "rider");
  if (!driver || !rider) throw new Error("test sign-in failed");
  const prof = await call("GET", "/driver/profile", driver);
  if (prof.body.onlineStatus !== "online") {
    const on = await call("POST", "/driver/availability", driver, { expectedVersion: prof.body.version, onlineStatus: "online", location: fix(TUNIS) });
    log(`driver online → HTTP ${on.status}`);
  }
  await sendFix(TUNIS);
  const active = await call("GET", "/rider/trips/active", rider);
  if (active.status === 200 && active.body.tripId) await call("POST", `/trips/${active.body.tripId}/cancel`, rider, { expectedVersion: active.body.version, reasonCode: "plans_changed" });

  save("rider_zones_tn", "GET /rider/zones?country=TN", await call("GET", "/rider/zones?country=TN", rider));
  save("rider_config_tn_tc", "GET /rider/config?zoneId=TN-TC", await call("GET", `/rider/config?zoneId=${ZONE}`, rider));
  const q = await call("POST", "/quotes", rider, { pickup: PICKUP, dropoff: DROPOFF, stops: [] });
  save("quote_tunis", "POST /quotes", q);
  const quote = (q.body.quotes ?? []).find((x) => x.categoryId === "economy") ?? (q.body.quotes ?? [])[0];
  if (!quote) throw new Error(`no quote (HTTP ${q.status})`);
  const book = await call("POST", "/trips", rider, { quoteId: quote.quoteId, categoryId: quote.categoryId, pickup: PICKUP, dropoff: DROPOFF, stops: [], kind: "live", paymentMethod: "cash" });
  if (book.status !== 201) throw new Error(`book HTTP ${book.status} ${book.body.reason ?? ""}`);
  tripId = book.body.tripId;
  let offers; let offer;
  for (let i = 0; i < 30 && !offer; i++) {
    offers = await call("GET", "/driver/offers", driver);
    offer = (offers.body.items ?? []).find((x) => x.tripId === tripId);
    if (!offer) await sleep(2000);
  }
  if (!offer) throw new Error("no offer in 60 s");
  save("driver_offers", "GET /driver/offers", offers);
  const acc = await call("POST", `/offers/${offer.offerId}/accept`, driver, { expectedVersion: offer.version });
  if (acc.status !== 200) throw new Error(`accept HTTP ${acc.status}`);
  save("trip_view_rider_accepted", "GET /trips/{tripId} (rider, accepted)", await call("GET", `/trips/${tripId}`, rider));
  await command("head-to-pickup");
  for (const [lat, lng] of [[36.804, 10.181], [36.802, 10.1805], [PICKUP.lat, PICKUP.lng]]) { await sendFix({ lat, lng }); await sleep(1200); }
  log(`arrive → HTTP ${(await command("arrive")).status}`);
  log(`board → HTTP ${(await command("board")).status}`);
  log(`start → HTTP ${(await command("start")).status}`);
  for (const [lat, lng] of [[36.81, 10.19], [36.82, 10.2], [36.832, 10.21], [36.842, 10.219], [DROPOFF.lat, DROPOFF.lng]]) { await sendFix({ lat, lng }); await sleep(1500); }
  save("trip_view_driver_in_trip", "GET /trips/{tripId} (driver, in_trip)", await call("GET", `/trips/${tripId}`, driver));
  const pv = await call("GET", `/driver/trips/${tripId}/complete-preview`, driver);
  const done = await command("complete", pv.status === 200 ? { previewId: pv.body.previewId, cashCollected: pv.body.cashDue } : {});
  ended = done.status === 200;
  log(`complete → HTTP ${done.status}`);
  save("trip_view_rider_completed", "GET /trips/{tripId} (rider, completed)", await call("GET", `/trips/${tripId}`, rider));
  save("trip_events_page", "GET /trips/{tripId}/events?after=0 (JSON replay)", await call("GET", `/trips/${tripId}/events?after=0&limit=50`, rider));
  save("receipt_rider", "GET /trips/{tripId}/receipt", await call("GET", `/trips/${tripId}/receipt`, rider));
  save("receipt_driver", "GET /driver/trips/{tripId}/receipt", await call("GET", `/driver/trips/${tripId}/receipt`, driver));
}

async function cleanup() {
  if (tripId && !ended && rider) {
    const t = await call("GET", `/trips/${tripId}`, rider);
    if (t.status === 200 && !["completed", "cancelled", "no_driver_found", "expired", "failed"].includes(t.body.status)) {
      const c = await call("POST", `/trips/${tripId}/cancel`, rider, { expectedVersion: t.body.version, reasonCode: "plans_changed" });
      log(`cleanup: cancel the unfinished trip → HTTP ${c.status}`);
    }
  }
  if (rider) log(`cleanup: rider active trip → HTTP ${(await call("GET", "/rider/trips/active", rider)).status} (204 = none)`);
  if (driver) {
    const p = await call("GET", "/driver/profile", driver);
    if (p.body.onlineStatus && p.body.onlineStatus !== "offline") log(`cleanup: driver offline → HTTP ${(await call("POST", "/driver/availability", driver, { expectedVersion: p.body.version, onlineStatus: "offline" })).status}`);
  }
}

try { await main(); } catch (error) { log(`FAIL ${String(error?.message ?? error)}`); process.exitCode = 1; } finally { await cleanup(); }
log(`\n${saved.length} answers saved:\n  ${saved.join("\n  ")}`);
