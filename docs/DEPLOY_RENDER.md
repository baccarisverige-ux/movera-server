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
   - `RESEND_API_KEY` (G30b): the Resend key for the e-mail change codes. Without it no code e-mail is sent (the apps
     say "codes cannot be sent yet"). Optional `EMAIL_FROM` (default `Movera <onboarding@resend.dev>`, which reaches
     only the Resend account owner's own address until an own domain is added in Resend) and `EMAIL_SEND_TIMEOUT_MS`
     (default 5000).
   - `ELKS_API_USERNAME` and `ELKS_API_PASSWORD` (contract v0.18.133 `smsSignIn`): the 46elks API username and
     password for the sign-in code SMS. Without BOTH no SMS is ever sent and every number that is not a test number is
     `sign_in_restricted`, as before. With both, a country still needs its admin switch (Pricing › Tips & limits ›
     "Real SMS sign-in codes", default off). Optional `SMS_SENDER_NAME` (3-11 letters and digits; default `Movera`).
     Only sign-in codes use these keys (invitation and SOS-contact SMS stay off). Owner steps: Rules `plan/SMS-SETUP-STEPS.md`.
   - `SOS_CONTACTS_SMS_SEND` (contract v0.18.151 `sosContactsSms.send`): `on` also sends the SOS emergency-contact SMS
     (the driver's SOS texts his contacts his position) through the same keys; unset or any other value = off, the
     default, and those SMS stay "not connected". The country switch (Tips & limits › Emergency numbers) still applies,
     and they count in the country's daily SMS limit with the sign-in codes.
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

### Forgot the admin password

- **Another Super admin** (same or wider zones) can make a new link with `POST /admin/agents/{adminId}/setup-link`
  and send it to them. The live admin panel has no button for it yet (its Team page is not live; Phase 5).
- **The only Super admin (the owner), free plan:** Render → movera-server → Environment → add
  `ADMIN_PASSWORD_RESET` with any new text (for example today's date) → Save (the service restarts). In **Logs**
  search for `admin password reset link` and open the `setupLink` (72 h, one use; the old password keeps working
  until the new one is chosen, then every open admin session ends). Each value gives one link only, so a sleeping
  server that wakes does not make more; for another reset later, type a different value. Remove the variable when
  done. Only people with access to the Render dashboard can do this, the same people who can read the first link.
- **With a shell or the database's external URL:** `DATABASE_URL=<external URL> npm run admin -- link --email <you>`
  prints a new link (from a checkout of this repository).
- A self-service "e-mail me a link" needs an e-mail provider, which Movera does not have yet; see
  `docs/audit/phase-4.md` (P4-4).

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

## Zones in the test week

Two open zones (migration 0014): **Z001 Stockholm län**, the whole county as one dispatch area, in kronor, and
**FR-PC Paris** with the inner suburbs, in euro. The sample prices of Paris are the Swedish ones converted
(1 kr ≈ 0,09 €) until the admin sets real ones in the panel. The old district zones (Norrmalm, Södermalm, …) are
closed. Address search suggests places in Sweden and France.

## 4. If the server was created from an older `render.yaml`

Render applies new entries of `render.yaml` on a Blueprint sync (Dashboard → Blueprints → movera-server → **Manual
Sync**), or add them by hand under the service's **Environment**: `OSRM_URL` = `https://router.project-osrm.org`
(road routes on the maps; without it distances are estimated and the rider's map draws a straight line).
