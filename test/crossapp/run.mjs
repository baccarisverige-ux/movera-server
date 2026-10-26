// Cross-app run (Audit Phase 3, not in CI): one ride with the Rider and Driver web builds and the admin panel in
// Chromium against a local movera-server. See README.md next to this file for the set-up.
//
//   node test/crossapp/run.mjs --out <dir> --setup-link '<admin setup link from the server log>' \
//        [--rider http://localhost:7001] [--driver http://localhost:7002] [--admin http://localhost:7003] \
//        [--api http://127.0.0.1:8080] [--canvaskit <rider build>/web/canvaskit]
//
// Needs `playwright` (PLAYWRIGHT_ROOT=$(npm root -g) for a global install). Steps: request, offer, accept, arrive, start,
// complete; at each step every app is screenshotted (<out>/<n>-<step>-<app>.png) and what it shows is written with
// the server's own view of the trip (GET /admin/trips/{id}) to <out>/steps.json.
//
// Stand-ins, on purpose: the browser's GPS is a script (window.__geo; headless Chromium answers a fresh
// getCurrentPosition only when the emulated position changes), and the rider's address lookups
// (/locations/autocomplete, /geocode, /reverse-geocode) are answered in the browser because a local server has no
// Google key. Trips, offers, dispatch, money and events are the real server's.
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Playwright from the repo, else from the global install (`npm root -g`), e.g. PLAYWRIGHT_ROOT=$(npm root -g).
const { chromium } = createRequire(process.env.PLAYWRIGHT_ROOT ? join(process.env.PLAYWRIGHT_ROOT, "x.js") : import.meta.url)("playwright");

const args = process.argv.slice(2);
const opt = (name, fallback) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : fallback);
const OUT = opt("out", "crossapp-out");
const RIDER = opt("rider", "http://localhost:7001");
const DRIVER = opt("driver", "http://localhost:7002");
const ADMIN = opt("admin", "http://localhost:7003");
const API = opt("api", "http://127.0.0.1:8080");
const CANVASKIT = opt("canvaskit", "");
const SETUP = opt("setup-link", "");
const ADMIN_PASSWORD = opt("admin-password", "crossapp-local-only-1");
const RIDER_PHONE = "701740608";
const DRIVER_PHONE = "701740605";
const PICKUP = { latitude: 59.3326, longitude: 18.0649 };
const DROPOFF = { latitude: 59.3429, longitude: 18.0496 };
mkdirSync(OUT, { recursive: true });

const fakeGeo = `(() => {
  window.__geo = window.__geo || { latitude: 59.3340, longitude: 18.0620, accuracy: 8 };
  const pos = () => ({ coords: { latitude: window.__geo.latitude, longitude: window.__geo.longitude, accuracy: window.__geo.accuracy ?? 8, altitude: null, altitudeAccuracy: null, heading: null, speed: window.__geo.speed ?? 0 }, timestamp: Date.now() });
  const watchers = new Map(); let n = 0;
  const geo = {
    getCurrentPosition(ok) { setTimeout(() => ok(pos()), 50); },
    watchPosition(ok) { const id = ++n; watchers.set(id, setInterval(() => ok(pos()), 1000)); setTimeout(() => ok(pos()), 50); return id; },
    clearWatch(id) { clearInterval(watchers.get(id)); watchers.delete(id); },
  };
  Object.defineProperty(navigator, "geolocation", { get: () => geo, configurable: true });
})();`;

const browser = await chromium.launch();
const net = { rider: [], driver: [], admin: [] };

async function context(name, options) {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, locale: "en-US", ...options });
  await ctx.addInitScript(() => { try { localStorage.setItem("flutter.movera_app_language", '"en"'); } catch { /* none */ } });
  await ctx.addInitScript(fakeGeo);
  if (CANVASKIT) {
    await ctx.route(/gstatic\.com\/flutter-canvaskit\/[^/]+\/(.*)$/, (route) => {
      const file = join(CANVASKIT, route.request().url().replace(/^.*flutter-canvaskit\/[^/]+\//, ""));
      return route.fulfill({ path: file, contentType: file.endsWith(".wasm") ? "application/wasm" : "text/javascript" }).catch(() => route.abort());
    });
  }
  const page = await ctx.newPage();
  page.on("response", async (r) => {
    if (!r.url().includes("/api/v1/")) return;
    let body = "";
    try { body = (await r.text()).slice(0, 4000); } catch { /* streams */ }
    net[name].push({ at: new Date().toISOString(), call: `${r.request().method()} ${new URL(r.url()).pathname}`, status: r.status(), body });
  });
  return page;
}

const semantics = (page) => page.evaluate(() => Array.from(document.querySelectorAll("flt-semantics")).map((el) => {
  const own = Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent).join("").trim();
  const r = el.getBoundingClientRect();
  return { label: (el.getAttribute("aria-label") || own || "").replace(/\n/g, " / "), x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width };
}).filter((s) => s.label && s.w > 0));
const enable = (page) => page.evaluate(() => document.querySelector("flt-semantics-placeholder")?.click());
async function tapLabel(page, pattern, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    await enable(page);
    const hit = (await semantics(page)).find((s) => pattern.test(s.label));
    if (hit) { await page.mouse.click(hit.x, hit.y); return hit.label; }
    await page.waitForTimeout(500);
  }
  throw new Error(`no ${pattern} on ${page.url()}`);
}
async function waitFor(what, test, timeout = 60000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const v = await test(); if (v) return v; await new Promise((r) => setTimeout(r, 500)); }
  for (const [app, page] of [["rider", rider], ["driver", driver], ["admin", admin]]) await page.screenshot({ path: join(OUT, `failed-${app}.png`) }).catch(() => {});
  writeFileSync(join(OUT, "network.json"), JSON.stringify(net, null, 1));
  throw new Error(`timed out waiting for ${what}`);
}
const lastCall = (name, re) => [...net[name]].reverse().find((c) => re.test(c.call));
async function swipe(page, x0, y, x1) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: x0, y }] });
  for (let x = x0; x <= x1; x += 10) { await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y }] }); await page.waitForTimeout(16); }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}
const setGeo = (page, g) => page.evaluate((g) => { window.__geo = { accuracy: 5, ...g }; }, g);

const mobile = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };
const rider = await context("rider", mobile);
const driver = await context("driver", mobile);
const admin = await context("admin", { viewport: { width: 1440, height: 900 } });

// The rider's address lookups (no Google key on a local server).
await rider.context().route("**/api/v1/locations/**", (route) => {
  const req = route.request();
  if (req.method() === "OPTIONS") return route.continue();
  const body = JSON.parse(req.postData() || "{}");
  const json = (o) => route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": new URL(RIDER).origin }, body: JSON.stringify(o) });
  const url = req.url();
  if (url.endsWith("/autocomplete")) return json({ suggestions: [{ title: "Odenplan", subtitle: "Stockholm", placeId: "crossapp-odenplan" }] });
  if (url.endsWith("/reverse-geocode")) return json({ address: "Sergels torg, Stockholm", latitude: body.latitude, longitude: body.longitude });
  // The app also geocodes the pickup's own label: answer each place by what was asked.
  if (url.endsWith("/geocode")) {
    return /odenplan/i.test(`${body.query} ${body.placeId ?? ""}`)
      ? json({ address: "Odenplan, Stockholm", latitude: DROPOFF.latitude, longitude: DROPOFF.longitude, placeId: "crossapp-odenplan" })
      : json({ address: "Sergels torg, Stockholm", latitude: PICKUP.latitude, longitude: PICKUP.longitude, placeId: "crossapp-sergels-torg" });
  }
  return route.continue();
});

// Phone sign-in shared by both apps (Sweden, code 1234 for the test numbers).
async function phoneSignIn(page, url, phone) {
  // The first screen settles slowly (fonts, flags); a try that does not reach the code step starts again.
  for (let attempt = 1; ; attempt++) {
    try { return await phoneSignInOnce(page, url, phone); } catch (error) { if (attempt >= 3) throw error; console.log(`sign-in retry: ${error.message}`); }
  }
}
async function phoneSignInOnce(page, url, phone) {
  await page.goto(url);
  await page.waitForTimeout(10000);
  await enable(page);
  await page.waitForTimeout(1000);
  const country = (await semantics(page)).find((s) => /Country code/.test(s.label));
  if (country && !/\+46/.test(country.label)) {
    await page.mouse.click(country.x, country.y); await page.waitForTimeout(2000);
    await page.mouse.click(195, 206); await page.waitForTimeout(500);
    await page.keyboard.type("Sweden", { delay: 60 }); await page.waitForTimeout(1500);
    await tapLabel(page, /^Sweden, \+46/);
    await page.waitForTimeout(1500);
    await waitFor("Sweden chosen", async () => (await enable(page), (await semantics(page)).some((s) => /Country code.*\+46/.test(s.label))), 10000);
  }
  // The terms checkbox sits under the phone field; the layout moves a little once the flag font loads.
  await enable(page);
  const terms = await waitFor("terms checkbox", async () => (await semantics(page)).find((s) => /terms|villkor|conditions/i.test(s.label)), 20000);
  await page.mouse.click(250, terms.y - 58); await page.waitForTimeout(600);
  await page.keyboard.type(phone, { delay: 50 }); await page.waitForTimeout(500);
  await page.mouse.click(32, terms.y);
  await tapLabel(page, /^(Continue|Fortsätt)$/);
  await waitFor("otp request", () => net[page === rider ? "rider" : "driver"].some((c) => /otp\/request/.test(c.call) && c.status === 200), 20000);
  await page.waitForTimeout(2500);
  await page.mouse.click(54, 630); await page.keyboard.type("1234", { delay: 80 });
  await page.waitForTimeout(800);
  await tapLabel(page, /^(Verify|Verifiera)$/);
  await waitFor("otp verify", () => net[page === rider ? "rider" : "driver"].some((c) => /otp\/verify/.test(c.call) && c.status === 200));
  await page.waitForTimeout(4000);
}

// Admin: password (first run) or sign-in.
if (SETUP) {
  await admin.goto(SETUP.replace(/^https?:\/\/[^/]+/, ADMIN));
  await admin.waitForTimeout(2000);
  const fields = admin.locator("input[type=password]");
  await fields.nth(0).fill(ADMIN_PASSWORD); await fields.nth(1).fill(ADMIN_PASSWORD);
  await admin.getByRole("button", { name: /Save password|Spara lösenord/ }).click();
  await admin.waitForTimeout(3000);
} else {
  await admin.goto(ADMIN); await admin.waitForTimeout(2000);
  await admin.locator("input[type=email]").fill(opt("admin-email", "p3x-admin@example.com"));
  await admin.locator("input[type=password]").fill(ADMIN_PASSWORD);
  await admin.locator("button[type=submit]").click(); await admin.waitForTimeout(3000);
}
const adminToken = async () => admin.evaluate(() => JSON.parse(sessionStorage.getItem("movera-admin-live-session") || "{}").accessToken);
const serverTrip = async (id) => (await fetch(`${API}/api/v1/admin/trips/${id}`, { headers: { authorization: `Bearer ${await adminToken()}` } })).json();

await phoneSignIn(driver, DRIVER, DRIVER_PHONE);
await driver.mouse.click(195, 735); // the radar: go online
await waitFor("driver online", () => lastCall("driver", /driver\/availability/)?.status === 200);
await waitFor("driver location", () => net.driver.some((c) => /driver\/location/.test(c.call)));

await phoneSignIn(rider, RIDER, RIDER_PHONE);
await tapLabel(rider, /^Not now$/).catch(() => {});
await rider.waitForTimeout(2000);
await setGeo(rider, PICKUP);
await tapLabel(rider, /^Allow location$/).catch(() => {});
await rider.waitForTimeout(2000);
await tapLabel(rider, /^Where to\?$/);
await rider.waitForTimeout(1500);
await rider.mouse.click(160, 146); await rider.keyboard.type("Odenplan", { delay: 50 });
await tapLabel(rider, /^Odenplan/);
await waitFor("quote", () => lastCall("rider", /POST \/api\/v1\/quotes/)?.status === 201);
await tapLabel(rider, /^Select Movera$/);
await tapLabel(rider, /^Confirm and search$/);
const booked = await waitFor("trip", () => lastCall("rider", /^POST \/api\/v1\/trips$/));
const tripId = JSON.parse(booked.body).tripId;

const steps = [];
async function step(n, name) {
  await admin.goto(`${ADMIN}/drivers`); await admin.waitForTimeout(2500);
  const shown = {};
  for (const [app, page] of [["rider", rider], ["driver", driver], ["admin", admin]]) {
    await page.screenshot({ path: join(OUT, `${n}-${name}-${app}.png`) });
    shown[app] = app === "admin" ? (await admin.locator("main").innerText().catch(() => "")).slice(0, 2000) : (await enable(page), (await semantics(page)).map((s) => s.label).join(" ‖ "));
  }
  const server = await serverTrip(tripId);
  steps.push({ n, name, at: new Date().toISOString(), tripId, server: { status: server.status, driverId: server.driverId, vehicle: server.driver?.vehicle, fare: server.fare, driverEarnings: server.driverEarnings, commission: server.commission, pickupPay: server.pickupPay }, shown });
  console.log(`${n} ${name}: server ${server.status}`);
}

await step(1, "request");
const offer = await waitFor("offer on the driver's feed", () => [...net.driver].reverse().find((c) => /driver\/offers/.test(c.call) && c.body.includes(tripId) && c.body.includes('"status":"open"')), 90000);
await driver.waitForTimeout(1500);
await step(2, "offer");
await driver.mouse.click(226, 601); // "Take the trip"
await waitFor("accept", () => lastCall("driver", /\/offers\/.*\/accept/)?.status === 200, 30000);
await driver.waitForTimeout(3000);
await step(3, "accept");
await setGeo(driver, { ...PICKUP, latitude: PICKUP.latitude + 0.00002 });
await driver.waitForTimeout(15000);
await driver.mouse.click(150, 770); // open the trip sheet
await driver.waitForTimeout(1500);
await driver.mouse.click(195, 790); // "I have arrived"
await waitFor("arrive", () => lastCall("driver", /\/arrive$/)?.status === 200, 30000);
await driver.waitForTimeout(3000);
await step(4, "arrive");
await tapLabel(rider, /^I'm on the way$/).catch(() => {});
await driver.waitForTimeout(2000);
for (let i = 0; i < 4 && lastCall("driver", /\/start$/)?.status !== 200; i++) {
  await swipe(driver, 45, 792, 375); // slide "Start the trip"
  await driver.waitForTimeout(4000);
}
await waitFor("start", () => lastCall("driver", /\/start$/)?.status === 200, 30000);
await driver.waitForTimeout(3000);
await step(5, "start");
for (let i = 1; i <= 10; i++) {
  await setGeo(driver, { latitude: PICKUP.latitude + ((DROPOFF.latitude - PICKUP.latitude) * i) / 10, longitude: PICKUP.longitude + ((DROPOFF.longitude - PICKUP.longitude) * i) / 10, speed: 8 });
  await driver.waitForTimeout(6000);
}
await setGeo(driver, { ...DROPOFF, speed: 0 });
await driver.waitForTimeout(12000);
await driver.mouse.click(195, 790); // "Collect cash"
await driver.waitForTimeout(2500);
await driver.screenshot({ path: join(OUT, "6a-collect-cash-driver.png") });
await driver.mouse.click(195, 763); // "End"
await waitFor("complete", () => lastCall("driver", /\/complete$/)?.status === 200, 30000);
await driver.waitForTimeout(4000);
await step(6, "complete");

writeFileSync(join(OUT, "steps.json"), JSON.stringify({ tripId, offer: JSON.parse(offer.body), steps }, null, 2));
writeFileSync(join(OUT, "network.json"), JSON.stringify(net, null, 1));
await browser.close();
console.log(`done: ${tripId}`);
