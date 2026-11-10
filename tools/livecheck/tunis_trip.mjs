#!/usr/bin/env node
/* global process, console, fetch, setTimeout, setInterval, clearInterval, AbortSignal */
/**
 * Live check (owner 2026-11-10): one whole cash trip in Grand Tunis (TN-TC, TND, 3 decimals, French) on staging,
 * in the order the apps use. Prints PASS/FAIL per step, keeps going after a FAIL, cancels a trip left half-way and
 * takes the driver offline at the end. Never prints tokens or the admin password.
 *   MOVERA_TEST_ADMIN_PASSWORD=… MOVERA_TEST_ADMIN_EMAIL=… node tools/livecheck/tunis_trip.mjs
 */
import { randomUUID } from "node:crypto";

const BASE = process.env.MOVERA_BASE ?? "https://movera-server.onrender.com/api/v1";
const RIDER = process.env.TN_RIDER_PHONE ?? "+46701740608";
const DRIVER = process.env.TN_DRIVER_PHONE ?? "+46701740605";
const CODE = process.env.TN_TEST_CODE ?? "1234"; // contract.json#auth.testSignIn
const ADMIN_EMAIL = process.env.MOVERA_TEST_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.MOVERA_TEST_ADMIN_PASSWORD;
const ZONE = "TN-TC";
const STEP = Number(process.env.TN_PRICE_STEP ?? 50); // src/rules/money.ts / seedConfig: TND prices in 50 millimes
const TUNIS = { lat: 36.8065, lng: 10.1815 };
const PICKUP = { address: "Avenue Habib Bourguiba, Tunis", lat: 36.8008, lng: 10.18 };
const DROPOFF = { address: "Aéroport Tunis-Carthage", lat: 36.851, lng: 10.2272 };

const results = [];
const money = [];
const record = (step, ok, why = "") => {
  results.push({ step, ok, why });
  console.log(`${ok ? "PASS" : "FAIL"}  ${step}${why ? ` — ${why}` : ""}`);
  return ok;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const redact = (body) => JSON.stringify(body, (k, v) => (/token|password|secret/i.test(k) ? "[REDACTED]" : v)).slice(0, 400);

async function call(method, path, token, body, extra = {}) {
  const headers = { "X-Api-Version": "0.5", "Accept-Language": "fr", ...extra };
  if (token) headers.authorization = `Bearer ${token}`;
  if (method !== "GET") {
    headers["content-type"] = "application/json";
    headers["idempotency-key"] = randomUUID();
  }
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(`${BASE}${path}`, { method, headers, ...(method !== "GET" ? { body: JSON.stringify(body ?? {}) } : {}), signal: AbortSignal.timeout(90_000) });
      const text = await res.text();
      let json = {};
      try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text.slice(0, 200) }; }
      return { status: res.status, body: json };
    } catch (error) {
      if (attempt >= 2) return { status: 0, body: { error: String(error) } };
      await sleep(3000);
    }
  }
}
const show = (r) => `HTTP ${r.status} ${redact(r.body)}`;
const isTnd = (m) => m && m.currency === "TND" && Number.isInteger(m.amountMinor);
const fmt = (m) => (m ? `${(m.amountMinor / 1000).toFixed(3)} ${m.currency}` : "—");

async function signIn(phone, app) {
  const otp = await call("POST", "/auth/otp/request", undefined, { phone, app });
  if (otp.status >= 300) return { error: `otp/request ${show(otp)}` };
  const v = await call("POST", "/auth/otp/verify", undefined, { phone, sessionId: otp.body.sessionId, code: CODE });
  if (v.status !== 200) return { error: `otp/verify ${show(v)}` };
  return { token: v.body.accessToken };
}

let fixAt = Date.now();
const fix = (at) => { fixAt = Math.max(Date.now(), fixAt + 1000); return { lat: at.lat, lng: at.lng, accuracy: 5, measuredAt: new Date(fixAt).toISOString() }; };

let driverToken; let riderToken; let tripId; let finished = false; let position = TUNIS; let beat;
const sendFix = (at) => { position = at; return call("POST", "/driver/location", driverToken, { fixes: [fix(at)] }); };
const tripOf = async (token, id = tripId) => call("GET", `/trips/${id}`, token);
async function command(path, body = {}) {
  const t = await tripOf(driverToken);
  return call("POST", `/trips/${tripId}/${path}`, driverToken, { expectedVersion: t.body.version, ...body });
}

async function main() {
  console.log(`Tunis trip live check → ${BASE}  (${new Date().toISOString()})`);
  // 1 driver sign-in
  const d = await signIn(DRIVER, "driver");
  if (!record("driver sign-in (POST /auth/otp/request + verify, app driver)", !!d.token, d.error)) return;
  driverToken = d.token;
  const prof = await call("GET", "/driver/profile", driverToken);
  record("driver profile has zone TN-TC", prof.status === 200 && (prof.body.zoneIds ?? []).includes(ZONE), `HTTP ${prof.status} zoneIds=${JSON.stringify(prof.body.zoneIds)} name=${prof.body.name ?? prof.body.displayName ?? "?"} onlineStatus=${prof.body.onlineStatus}`);
  // 2 online with a fresh Tunis fix
  let online = { status: 200, body: { onlineStatus: prof.body.onlineStatus } };
  if (prof.body.onlineStatus !== "online") online = await call("POST", "/driver/availability", driverToken, { expectedVersion: prof.body.version, onlineStatus: "online", location: fix(TUNIS) });
  record("driver online in Tunis (POST /driver/availability)", online.status === 200 && online.body.onlineStatus === "online", show(online));
  const loc = await sendFix(TUNIS);
  record("driver location fix in Tunis (POST /driver/location)", loc.status === 200, show(loc));
  beat = setInterval(() => { void sendFix(position); }, 15_000); // the app sends its position while online

  // 3 rider sign-in, zones
  const r = await signIn(RIDER, "rider");
  if (!record("rider sign-in (app rider)", !!r.token, r.error)) return;
  riderToken = r.token;
  const rp = await call("GET", "/rider/profile", riderToken);
  record("rider profile locale fr", rp.status === 200 && (rp.body.locale ?? rp.body.language) === "fr", `HTTP ${rp.status} locale=${rp.body.locale ?? rp.body.language}`);
  const active = await call("GET", "/rider/trips/active", riderToken);
  if (active.status === 200 && active.body.tripId) {
    const c = await call("POST", `/trips/${active.body.tripId}/cancel`, riderToken, { expectedVersion: active.body.version, reasonCode: "plans_changed" });
    record("rider had an old active trip → cancelled first", c.status === 200, `${active.body.tripId} ${show(c)}`);
  }
  const zones = await call("GET", "/rider/zones?country=TN", riderToken);
  const tn = (zones.body.zones ?? []).find((z) => z.zoneId === ZONE);
  record("GET /rider/zones?country=TN contains TN-TC (TND, open)", !!tn && tn.currency === "TND" && tn.open === true, `HTTP ${zones.status} ${tn ? `name=${JSON.stringify(tn.names?.fr ?? tn.name)} currency=${tn.currency} open=${tn.open}` : redact(zones.body)}`);

  // 4 quote
  const q = await call("POST", "/quotes", riderToken, { pickup: PICKUP, dropoff: DROPOFF, stops: [] });
  const quotes = q.body.quotes ?? [];
  record("quote Habib Bourguiba → Tunis-Carthage (POST /quotes)", q.status === 201 && quotes.length > 0 && q.body.zoneId === ZONE, `HTTP ${q.status} zoneId=${q.body.zoneId} categories=${quotes.map((x) => `${x.categoryId}:${fmt(x.fare ?? x.total ?? x.price)}`).join(", ") || redact(q.body)}`);
  if (quotes.length === 0) return;
  const amounts = [];
  const walk = (o, p = "") => { if (o && typeof o === "object") { if ("amountMinor" in o && "currency" in o) amounts.push([p, o]); else for (const [k, v] of Object.entries(o)) walk(v, `${p}.${k}`); } };
  walk(q.body);
  const bad = amounts.filter(([, m]) => !isTnd(m));
  record("every quote amount is TND", amounts.length > 0 && bad.length === 0, bad.length ? bad.slice(0, 5).map(([p, m]) => `${p}=${JSON.stringify(m)}`).join("; ") : `${amounts.length} amounts`);
  const fares = quotes.map((x) => x.fare ?? x.total).filter(Boolean);
  const offStep = fares.filter((m) => m.amountMinor % STEP !== 0);
  record(`quoted fares are multiples of ${STEP} millimes (3 decimals)`, fares.length > 0 && offStep.length === 0, fares.map(fmt).join(", "));
  const quote = quotes.find((x) => x.categoryId === "economy") ?? quotes[0];
  money.push(["quote", quote.categoryId, fmt(quote.fare ?? quote.total)]);

  // 5 book cash
  const book = await call("POST", "/trips", riderToken, { quoteId: quote.quoteId, categoryId: quote.categoryId, pickup: PICKUP, dropoff: DROPOFF, stops: [], kind: "live", paymentMethod: "cash" });
  if (!record("book live trip, payment cash (POST /trips)", book.status === 201 && !!book.body.tripId, `HTTP ${book.status} tripId=${book.body.tripId} status=${book.body.status} fare=${fmt(book.body.fare)} ${book.status !== 201 ? redact(book.body) : ""}`)) return;
  tripId = book.body.tripId;
  record("booked fare TND = quote", isTnd(book.body.fare) && book.body.fare.amountMinor === (quote.fare ?? quote.total).amountMinor, `${fmt(book.body.fare)} vs ${fmt(quote.fare ?? quote.total)}`);

  // 6 offer (the driver app polls GET /driver/offers as its fallback to the stream)
  let offer;
  for (let i = 0; i < 30 && !offer; i++) {
    const o = await call("GET", "/driver/offers", driverToken);
    offer = (o.body.items ?? []).find((x) => x.tripId === tripId);
    if (!offer) await sleep(2000);
  }
  if (!record("driver receives the offer (GET /driver/offers)", !!offer, offer ? `offerId=${offer.offerId} earnings=${fmt(offer.driverEarnings)}` : `no offer for ${tripId} in 60 s; trip=${redact((await tripOf(riderToken)).body).slice(0, 300)}`)) return;
  record("offer driverEarnings in TND", isTnd(offer.driverEarnings) && offer.driverEarnings.amountMinor % 1 === 0, fmt(offer.driverEarnings));
  const acc = await call("POST", `/offers/${offer.offerId}/accept`, driverToken, { expectedVersion: offer.version });
  if (!record("accept (POST /offers/{id}/accept)", acc.status === 200 && acc.body.status === "accepted", show(acc))) return;
  const seen = await tripOf(riderToken);
  record("rider sees accepted + driver, never the driver's money", seen.body.status === "accepted" || seen.body.status === "driver_to_pickup" ? !("driverEarnings" in seen.body) && !!seen.body.driver : false, `status=${seen.body.status} driver=${seen.body.driver?.name ?? seen.body.driver?.driverId}`);

  // 7 head to pickup → arrive → board → start
  const path = [[36.804, 10.181], [36.802, 10.1805], [PICKUP.lat, PICKUP.lng]];
  let res = await command("head-to-pickup");
  record("head-to-pickup", res.status === 200 && res.body.status === "driver_to_pickup", show(res));
  for (const [lat, lng] of path) { await sendFix({ lat, lng }); await sleep(1200); }
  res = await command("arrive");
  record("arrived (POST /trips/{id}/arrive)", res.status === 200 && res.body.status === "arrived", show(res));
  res = await command("board");
  record("rider on board (POST /trips/{id}/board)", res.status === 200 && res.body.status === "rider_onboard", show(res));
  res = await command("start");
  record("start (POST /trips/{id}/start)", res.status === 200 && res.body.status === "in_trip", show(res));
  const route = [[36.81, 10.19], [36.82, 10.2], [36.832, 10.21], [36.842, 10.219], [DROPOFF.lat, DROPOFF.lng]];
  for (const [lat, lng] of route) { await sendFix({ lat, lng }); await sleep(1500); }

  // 8 finish: preview → complete with the cash collected
  const pv = await call("GET", `/driver/trips/${tripId}/complete-preview`, driverToken);
  record("complete-preview (GET /driver/trips/{id}/complete-preview): cashDue TND, step", pv.status === 200 && isTnd(pv.body.cashDue) && pv.body.cashDue.amountMinor % STEP === 0, `HTTP ${pv.status} cashDue=${fmt(pv.body.cashDue)} fare=${fmt(pv.body.fare)} ${pv.status !== 200 ? redact(pv.body) : ""}`);
  money.push(["complete-preview cashDue", fmt(pv.body.cashDue)]);
  res = await command("complete", pv.status === 200 ? { previewId: pv.body.previewId, cashCollected: pv.body.cashDue } : {});
  finished = record("finish (POST /trips/{id}/complete)", res.status === 200 && res.body.status === "completed", `HTTP ${res.status} status=${res.body.status} fare=${fmt(res.body.fare)} earnings=${fmt(res.body.driverEarnings)} ${res.status !== 200 ? redact(res.body) : ""}`);
  if (!finished) return;
  money.push(["completed fare", fmt(res.body.fare)], ["driver earnings", fmt(res.body.driverEarnings)]);
  const fare = res.body.fare;
  record("final fare TND, multiple of the step", isTnd(fare) && fare.amountMinor % STEP === 0, fmt(fare));

  // 9 cash settled + receipt
  const rv = await tripOf(riderToken);
  const pay = rv.body.payment ?? {};
  record("cash payment settled (rider trip view)", rv.body.status === "completed" && (rv.body.paymentMethod ?? pay.method) === "cash" && /settled|paid|captured|collected/.test(String(pay.status ?? rv.body.paymentStatus)), `status=${rv.body.status} paymentMethod=${rv.body.paymentMethod ?? pay.method} paymentStatus=${pay.status ?? rv.body.paymentStatus}`);
  const rc = await call("GET", `/trips/${tripId}/receipt`, riderToken);
  const lines = rc.body.lines ?? rc.body.fareLines ?? rc.body.breakdown ?? [];
  const sum = lines.reduce((s, l) => s + (l.amount?.amountMinor ?? 0), 0);
  record("rider receipt (GET /trips/{id}/receipt): TND, cash, total = completed fare", rc.status === 200 && rc.body.currency === "TND" && rc.body.paymentMethod === "cash" && rc.body.total?.amountMinor === fare.amountMinor, `HTTP ${rc.status} currency=${rc.body.currency} method=${rc.body.paymentMethod} total=${fmt(rc.body.total)} cashPaid=${fmt(rc.body.cashPaid)} ${rc.status !== 200 ? redact(rc.body) : ""}`);
  record("receipt fare lines sum to the total", lines.length > 0 && sum === rc.body.total?.amountMinor && lines.every((l) => !l.amount || l.amount.currency === "TND"), `${lines.length} lines ${lines.map((l) => `${l.code ?? l.label}=${fmt(l.amount)}`).join(", ")} sum=${(sum / 1000).toFixed(3)}`);
  money.push(["receipt total", fmt(rc.body.total)]);

  // 10 driver earnings
  const dr = await call("GET", `/driver/trips/${tripId}/receipt`, driverToken);
  record("driver receipt (GET /driver/trips/{id}/receipt): TND, total = fare, no rider wallet line", dr.status === 200 && dr.body.currency === "TND" && dr.body.total?.amountMinor === fare.amountMinor && !("walletPaid" in dr.body), `HTTP ${dr.status} total=${fmt(dr.body.total)} cashPaid=${fmt(dr.body.cashPaid)}`);
  const dv = await tripOf(driverToken);
  const pickupPay = dv.body.pickupPay?.amountMinor ?? 0;
  record("driver trip view: driverEarnings TND + breakdown", isTnd(dv.body.driverEarnings) && dv.body.driverEarnings.amountMinor === res.body.driverEarnings.amountMinor, `earnings=${fmt(dv.body.driverEarnings)} pickupPay=${fmt(dv.body.pickupPay)} breakdown=${(dv.body.earningsBreakdown ?? []).map((l) => `${l.code}=${fmt(l.amount)}`).join(", ")}`);
  money.push(["driver pickupPay", fmt(dv.body.pickupPay)]);
  const er = await call("GET", "/driver/earnings?period=day&currency=TND", driverToken);
  const day = (er.body.periods ?? [])[0] ?? {};
  record("driver earnings report (GET /driver/earnings?period=day&currency=TND) has the trip in TND", er.status === 200 && isTnd(day.gross) && day.tripCount >= 1 && day.gross.amountMinor >= fare.amountMinor && day.net.amountMinor >= dv.body.driverEarnings.amountMinor + pickupPay, `HTTP ${er.status} tripCount=${day.tripCount} gross=${fmt(day.gross)} commission=${fmt(day.commission)} net=${fmt(day.net)} cash=${fmt(day.cashCollected)}`);
  money.push(["earnings day gross/net", `${fmt(day.gross)} / ${fmt(day.net)}`]);

  // 11 admin
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) record("admin sign-in", false, "MOVERA_TEST_ADMIN_EMAIL / MOVERA_TEST_ADMIN_PASSWORD not set");
  else {
    const a = await call("POST", "/admin/auth/sign-in", undefined, { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    if (record("admin sign-in (POST /admin/auth/sign-in)", a.status === 200 && !!a.body.accessToken, `HTTP ${a.status}${a.status !== 200 ? ` ${redact(a.body)}` : ""}`)) {
      const list = await call("GET", `/admin/trips?zoneId=${ZONE}&status=completed`, a.body.accessToken);
      const row = (list.body.items ?? []).find((t) => t.tripId === tripId);
      record("admin trip list (GET /admin/trips?zoneId=TN-TC&status=completed) has the trip", list.status === 200 && !!row, `HTTP ${list.status} ${row ? `status=${row.status} zone=${row.zoneId} fare=${fmt(row.fare)}` : `not in ${(list.body.items ?? []).length} rows ${list.status !== 200 ? redact(list.body) : ""}`}`);
      const one = await call("GET", `/admin/trips/${tripId}`, a.body.accessToken);
      record("admin trip view: completed, TN-TC, TND", one.status === 200 && one.body.status === "completed" && one.body.zoneId === ZONE && isTnd(one.body.fare), `HTTP ${one.status} status=${one.body.status} zone=${one.body.zoneId} fare=${fmt(one.body.fare)} earnings=${fmt(one.body.driverEarnings)}`);
    }
  }

  // 12 tip 1 DT, ratings
  const tip = await call("POST", `/trips/${tripId}/tip`, riderToken, { amount: { amountMinor: 1000, currency: "TND" }, method: "cash" });
  record("rider tip 1.000 TND cash (POST /trips/{id}/tip)", tip.status === 201 && tip.body.amount?.amountMinor === 1000, show(tip));
  const rr = await call("POST", `/trips/${tripId}/rating`, riderToken, { stars: 5 });
  record("rider rates the driver (POST /trips/{id}/rating)", rr.status < 300, `HTTP ${rr.status}${rr.status >= 300 ? ` ${redact(rr.body)}` : ""}`);
  const drr = await call("POST", `/trips/${tripId}/rating`, driverToken, { stars: 5 });
  record("driver rates the rider", drr.status < 300, `HTTP ${drr.status}${drr.status >= 300 ? ` ${redact(drr.body)}` : ""}`);
  const after = await call("GET", "/rider/trips/active", riderToken);
  record("rider has no active trip after", after.status === 204, `HTTP ${after.status}`);
}

async function cleanup() {
  if (beat) clearInterval(beat);
  if (tripId && !finished && riderToken) {
    const t = await tripOf(riderToken);
    if (t.status === 200 && !["completed", "cancelled", "no_driver_found", "expired"].includes(t.body.status)) {
      const c = await call("POST", `/trips/${tripId}/cancel`, riderToken, { expectedVersion: t.body.version, reasonCode: "plans_changed" });
      record("cleanup: cancel the unfinished trip", c.status === 200, show(c));
    }
  }
  if (driverToken) {
    const p = await call("GET", "/driver/profile", driverToken);
    if (p.body.onlineStatus && p.body.onlineStatus !== "offline") {
      const off = await call("POST", "/driver/availability", driverToken, { expectedVersion: p.body.version, onlineStatus: "offline" });
      record("cleanup: driver offline", off.status === 200, show(off));
    }
  }
}

try { await main(); } catch (error) { record("unexpected error", false, String(error?.stack ?? error)); } finally { await cleanup(); }
console.log(`\ntripId: ${tripId ?? "—"}`);
for (const m of money) console.log(`money  ${m.join("  ")}`);
console.log("\n| # | step | result |\n|---|---|---|");
results.forEach((r, i) => console.log(`| ${i + 1} | ${r.step} | ${r.ok ? "PASS" : `FAIL: ${r.why.replaceAll("|", "/")}`} |`));
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} PASS, ${failed} FAIL`);
process.exitCode = failed ? 1 : 0;
