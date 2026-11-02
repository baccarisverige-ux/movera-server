# Cross-app run (manual, not in CI)

One ride with the three apps together against a local server: the Rider and Driver **web builds** (Flutter) and
the admin panel, in headless Chromium (Playwright). Not in CI: it needs both Flutter builds and Chromium. Results of
the audit run: `docs/audit/phase-3-crossapp.md`.

## Set-up

```sh
# 1. Postgres and a database
pg_ctlcluster 16 main start
psql -U postgres -c 'create database movera_crossapp owner movera'

# 2. The server (staging: test accounts, the fixed test code (contract.json#auth.testSignIn), sample settings, bootstrap admin)
MOVERA_ENV=staging HOST=127.0.0.1 PORT=8080 \
DATABASE_URL=postgres://movera:movera@127.0.0.1:5432/movera_crossapp \
JWT_SECRET=$(openssl rand -hex 32) SEED_TEST_ON_START=true \
ADMIN_BOOTSTRAP_EMAIL=crossapp-admin@example.com ADMIN_PANEL_URL=http://localhost:7003 \
CORS_ORIGINS=http://localhost:7001,http://localhost:7002,http://localhost:7003 \
npx tsx src/main.ts | tee server.log      # the log holds "admin password link" (setupLink)

# 3. The builds, with the flags of each repo's Pages workflow, pointed at the HTTPS front (step 4)
#    (the rider app refuses a non-https API in a staging build)
cd movera-rider-app  && flutter build web --release --pwa-strategy=none --dart-define=MOVERA_FLAVOR=staging \
  --dart-define=MOVERA_API_BASE_URL=https://localhost:8443 --dart-define=MOVERA_AUTH_REQUIRED=true
cd Movera-driver-app && flutter build web --release --dart-define=MOVERA_AUTH_REQUIRED=true \
  --dart-define=MOVERA_API_BASE_URL=https://localhost:8443
cd Admin-panel-movera-dispatch/webapp && VITE_ADMIN_API=https://localhost:8443 npx vite build --base=/

# 4. HTTPS front for the server (self-signed, the browser ignores the certificate) and the three sites
openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem -days 30 -subj /CN=localhost
node test/crossapp/serve.mjs --cert cert.pem --key key.pem --api 8080 --tls 8443 \
  --site 7001=<rider>/build/web --site 7002=<driver>/build/web --site 7003=<admin>/webapp/dist

# 5. The ride
PLAYWRIGHT_ROOT=$(npm root -g) node test/crossapp/run.mjs --out out \
  --setup-link '<setupLink from server.log>' --canvaskit <rider>/build/web/canvaskit
```

`out/` gets a screenshot per step and app (`<n>-<step>-<app>.png`), `steps.json` (what each app showed next to the
server's `GET /admin/trips/{id}`) and `network.json` (every API call each app made, with the answer).

## Stand-ins (say so when reporting)

- **GPS**: `navigator.geolocation` is replaced by a script position (`window.__geo`) the run moves. Headless
  Chromium's own emulation answers a fresh `getCurrentPosition` only when the emulated position changes, so the
  driver app's 10 s location batches time out without it.
- **Address search**: the rider's `/locations/autocomplete`, `/geocode` and `/reverse-geocode` are answered in the
  browser (Sergels torg → Odenplan): a local server has no Google key (they answer 503).
- **CanvasKit** is served from the local build (`--canvaskit`) because the sandbox cannot reach gstatic.com.
- **Maps**: no Google Maps key, so the map areas are empty / show Google's error; no OSRM, so the driver app says
  "route not available" and the server prices from straight-line estimates.

The script clicks by screen position on a 390 × 844 phone viewport (the Flutter apps draw to a canvas; the rider app
has a semantics tree, the driver app's is mostly empty). A layout change in either app can move a button: check the
screenshots when a step times out.
