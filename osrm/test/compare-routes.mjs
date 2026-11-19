#!/usr/bin/env node
// Compares 20 Stockholm car routes: own route server vs the public demo server vs Google Routes (optional).
// Node 20+, no packages.
//   node test/compare-routes.mjs --own http://127.0.0.1:5000
//   node test/compare-routes.mjs --own http://127.0.0.1:5000 --no-demo
//   GOOGLE_ROUTES_API_KEY=... node test/compare-routes.mjs --own http://127.0.0.1:5000     (20 Google calls: inside the free monthly amount)
//   --pairs file.json   other pairs: [{"name":"..","from":[lat,lng],"to":[lat,lng]}, ...]
// It sends the same question movera-server sends (src/maps/routing.ts:133). One demo call per 1.2 s (its rule: max 1 per second).
import { readFileSync } from "node:fs";

const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
const OWN = arg("--own");
const DEMO = process.argv.includes("--no-demo") ? undefined : (arg("--demo") ?? "https://router.project-osrm.org");
const GOOGLE_KEY = process.env.GOOGLE_ROUTES_API_KEY;
if (!OWN) { console.error("Give the own route server: --own http://host:5000"); process.exit(2); }

// [lat, lng]. Centre, suburbs, both airports, motorway, short hops, one long trip.
const STOCKHOLM = [
  ["Central Station -> Arlanda Airport T5", [59.3303, 18.0586], [59.6498, 17.9300]],
  ["Central Station -> Bromma Airport", [59.3303, 18.0586], [59.3544, 17.9416]],
  ["Stureplan -> Slussen", [59.3360, 18.0735], [59.3195, 18.0722]],
  ["Odenplan -> Medborgarplatsen", [59.3430, 18.0497], [59.3143, 18.0735]],
  ["Gamla stan -> Karolinska Solna", [59.3250, 18.0707], [59.3496, 18.0320]],
  ["Kista Galleria -> Central Station", [59.4027, 17.9443], [59.3303, 18.0586]],
  ["Solna Mall of Scandinavia -> Globen", [59.3703, 18.0037], [59.2935, 18.0830]],
  ["Sodermalm Hornstull -> Ostermalmstorg", [59.3158, 18.0340], [59.3350, 18.0790]],
  ["Liljeholmen -> Sundbyberg", [59.3105, 18.0227], [59.3611, 17.9716]],
  ["Nacka Forum -> Stureplan", [59.3098, 18.1640], [59.3360, 18.0735]],
  ["Taby Centrum -> Central Station", [59.4441, 18.0710], [59.3303, 18.0586]],
  ["Huddinge Hospital -> Sodersjukhuset", [59.2215, 17.9390], [59.3097, 18.0558]],
  ["Lidingo Centrum -> Djurgarden Vasa Museum", [59.3665, 18.1330], [59.3280, 18.0914]],
  ["Hagersten Telefonplan -> Alvsjo Stockholmsmassan", [59.2983, 17.9970], [59.2772, 18.0110]],
  ["Vallingby Centrum -> Bromma Airport", [59.3633, 17.8720], [59.3544, 17.9416]],
  ["Sollentuna Centrum -> Arlanda Airport T5", [59.4280, 17.9510], [59.6498, 17.9300]],
  ["Farsta Centrum -> Skanstull", [59.2437, 18.0930], [59.3079, 18.0762]],
  ["Hammarby Sjostad -> Kungsholmen Fridhemsplan", [59.3040, 18.1040], [59.3323, 18.0290]],
  ["Royal Palace -> City Hall (short)", [59.3268, 18.0717], [59.3275, 18.0543]],
  ["Central Station -> Uppsala Central (long)", [59.3303, 18.0586], [59.8581, 17.6463]],
].map(([name, from, to]) => ({ name, from, to }));

const pairs = arg("--pairs") ? JSON.parse(readFileSync(arg("--pairs"), "utf8")) : STOCKHOLM;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function osrm(base, p) {
  const c = (x) => `${x[1].toFixed(6)},${x[0].toFixed(6)}`;
  const url = `${base.replace(/\/$/, "")}/route/v1/driving/${c(p.from)};${c(p.to)}?overview=false&geometries=geojson&steps=false&alternatives=false`;
  const t0 = Date.now();
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const b = await r.json();
    const best = b.routes?.[0];
    if (!r.ok || b.code !== "Ok" || !best) return { error: `${r.status} ${b.code ?? ""}`.trim() };
    // How far the server moved each point to reach a road. Far = the point is outside the map.
    const snap = Math.max(...(b.waypoints ?? []).map((w) => w.distance ?? 0));
    return { m: best.distance, s: best.duration, ms: Date.now() - t0, snap };
  } catch (e) { return { error: e.name === "TimeoutError" ? "timeout" : "no answer" }; }
}

async function google(p) {
  const point = (x) => ({ location: { latLng: { latitude: x[0], longitude: x[1] } } });
  const t0 = Date.now();
  try {
    const r = await fetch("https://routes.googleapis.com/directions/v2:computeRoutes", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Goog-Api-Key": GOOGLE_KEY, "X-Goog-FieldMask": "routes.duration,routes.distanceMeters" },
      body: JSON.stringify({ origin: point(p.from), destination: point(p.to), travelMode: "DRIVE", routingPreference: "TRAFFIC_AWARE" }),
      signal: AbortSignal.timeout(8000),
    });
    const b = await r.json();
    const best = b.routes?.[0];
    if (!r.ok || !best) return { error: `${r.status} ${b.error?.status ?? ""}`.trim() };
    return { m: best.distanceMeters, s: Number(String(best.duration).replace("s", "")), ms: Date.now() - t0 };
  } catch { return { error: "no answer" }; }
}

const km = (x) => (x.error ? x.error : (x.m / 1000).toFixed(1));
const min = (x) => (x.error ? "-" : (x.s / 60).toFixed(0));
const pct = (a, b) => (a.error || b.error || !b.m ? "-" : `${(((a.m - b.m) / b.m) * 100).toFixed(1)} %`);
const pctT = (a, b) => (a.error || b.error || !b.s ? "-" : `${(((a.s - b.s) / b.s) * 100).toFixed(0)} %`);

const rows = [];
for (const p of pairs) {
  const own = await osrm(OWN, p);
  const demo = DEMO ? await osrm(DEMO, p) : { error: "skipped" };
  if (DEMO) await sleep(1200);
  const goo = GOOGLE_KEY ? await google(p) : { error: "no key" };
  rows.push({ p, own, demo, goo });
}

console.log("| # | Route | Own km | Own min | Own ms | Demo km | Demo min | km own vs demo | Google km | Google min (traffic) | km own vs Google | min own vs Google |");
console.log("|---|---|---|---|---|---|---|---|---|---|---|---|");
rows.forEach(({ p, own, demo, goo }, i) =>
  console.log(`| ${i + 1} | ${p.name} | ${km(own)} | ${min(own)} | ${own.ms ?? "-"} | ${km(demo)} | ${min(demo)} | ${pct(own, demo)} | ${km(goo)} | ${min(goo)} | ${pct(own, goo)} | ${pctT(own, goo)} |`));

const ownOk = rows.filter((r) => !r.own.error);
const far = ownOk.filter((r) => r.own.snap > 300);
const near = (r, other, limit) => !r[other].error && Math.abs(r.own.m - r[other].m) / r[other].m <= limit;
const demoSeen = rows.filter((r) => !r.own.error && !r.demo.error);
const gooSeen = rows.filter((r) => !r.own.error && !r.goo.error);
const slow = ownOk.filter((r) => r.own.ms > 500);
console.log("");
console.log(`Own server answered: ${ownOk.length} of ${rows.length}   (PASS needs all)`);
console.log(`Points moved more than 300 m to reach a road (outside the map?): ${far.length}   (PASS needs 0)`);
console.log(`Answers slower than 500 ms: ${slow.length}   (PASS needs 0)`);
if (demoSeen.length) console.log(`Distance within 2 % of the demo server: ${demoSeen.filter((r) => near(r, "demo", 0.02)).length} of ${demoSeen.length}   (PASS needs 18 of 20)`);
if (gooSeen.length) console.log(`Distance within 10 % of Google: ${gooSeen.filter((r) => near(r, "goo", 0.10)).length} of ${gooSeen.length}   (PASS needs 17 of 20; time is expected to be shorter than Google in rush hour: no live traffic)`);
const fail = ownOk.length !== rows.length || far.length > 0 || slow.length > 0 || (demoSeen.length >= 10 && demoSeen.filter((r) => near(r, "demo", 0.02)).length < Math.ceil(demoSeen.length * 0.9)) || (gooSeen.length >= 10 && gooSeen.filter((r) => near(r, "goo", 0.10)).length < Math.ceil(gooSeen.length * 0.85));
console.log(fail ? "RESULT: FAIL" : "RESULT: PASS");
process.exit(fail ? 1 : 0);
