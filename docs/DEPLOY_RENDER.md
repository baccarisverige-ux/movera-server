# Trying the test week on Render

`render.yaml` makes the server (Docker) and its PostgreSQL 16, both in Frankfurt, on Render's **free** plans. Free
is for trying things out: the server sleeps after a while without use (the first request then takes about a
minute, and no offers go out while it sleeps), and the free database expires after some weeks. For a real test
week change the plans to `starter` (server) and `basic-256mb` (database). The long-term host is the Oxahost server
(`docs/DECISIONS.md`, decision 3); moving there only changes the server address the apps use.

## 1. Create it (once)

1. render.com → sign in with GitHub → allow access to `baccarisverige-ux/movera-server`.
2. **New → Blueprint** → pick `movera-server`, branch `main` (before the merge: `driver-round-4`) → **Apply**.
3. It asks for two values:
   - `ADMIN_BOOTSTRAP_EMAIL`: your e-mail; you become the Super admin.
   - `GOOGLE_MAPS_API_KEY`: the Maps key (address search answers 503 without it; everything else works).
4. Wait until `movera-server` says **Live**. Its address is on the service page, e.g.
   `https://movera-server-xxxx.onrender.com`. Check `…/healthz` shows `"env":"staging"`.

## 2. Accounts, settings and your admin password (nothing to type)

`SEED_TEST_ON_START=true` makes, on the first start, the test fleet (code `MV-TESTA`), three active drivers with
approved cars and three riders, and publishes the contract's sample prices, dispatch rules and app settings in every
open zone that has none. All test numbers sign in with code `1234`:

- Drivers: +46 70 174 06 05, 06, 07
- Riders: +46 70 174 06 08, 09, 10

Your admin password link is in **movera-server → Logs**: search for `admin password link` and open the
`setupLink` (valid 72 h; a new one appears after a restart once it has expired and no password was chosen).
Later starts change nothing: testers' changes stay.

On a paid plan with a shell the same is `node dist/admin/cli.js seed-test` and
`node dist/admin/cli.js create --email you@example.com --name "Your Name" --role super`.

## 3. Point the apps at it

In each app repository on GitHub → **Settings → Secrets and variables → Actions → Variables**, add
`MOVERA_LIVE_API_URL` = the server address (no trailing slash), then run the Pages workflow again. The live builds
appear next to the demos:

- Admin: `https://baccarisverige-ux.github.io/Admin-panel-movera-dispatch/live/`
- Driver: `https://baccarisverige-ux.github.io/Movera-driver-app/live/`
- Rider: `https://baccarisverige-ux.github.io/movera-rider-app/live/`

`CORS_ORIGINS` (in `render.yaml`) lets these pages call the server. `ADMIN_PANEL_URL` makes the password link open
the live admin.
