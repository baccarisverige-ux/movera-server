# Test week on Render

`render.yaml` makes the server (Docker, Starter plan) and its PostgreSQL 16 (Basic 256 MB), both in Frankfurt.

## 1. Create it (once)

1. render.com → sign in with GitHub → allow access to `baccarisverige-ux/movera-server`.
2. **New → Blueprint** → pick `movera-server`, branch `main` (before the merge: `driver-round-4`) → **Apply**.
3. When it asks for `GOOGLE_MAPS_API_KEY`, paste the key (address search answers 503 without it; everything
   else works).
4. Wait until `movera-server` says **Live**. Its address is on the service page, e.g.
   `https://movera-server-xxxx.onrender.com`. Check `…/healthz` shows `"env":"staging"`.

## 2. Accounts and settings (once; again after the testers' real numbers are in `src/drivers/seedTest.ts`)

`movera-server` → **Shell**:

```sh
node dist/admin/cli.js seed-test
node dist/admin/cli.js create --email you@example.com --name "Your Name" --role super
```

`seed-test` makes the test fleet (code `MV-TESTA`), three active drivers with approved cars, three riders, and
publishes the contract's sample prices, dispatch rules and app settings in every open zone that has none yet. All
test numbers sign in with code `1234`. `create` prints a link (72 h) to choose the admin password.

## 3. Point the apps at it

In each app repository on GitHub → **Settings → Secrets and variables → Actions → Variables**, add
`MOVERA_LIVE_API_URL` = the server address (no trailing slash), then run the Pages workflow again. The live builds
appear next to the demos:

- Admin: `https://baccarisverige-ux.github.io/Admin-panel-movera-dispatch/live/`
- Driver: `https://baccarisverige-ux.github.io/Movera-driver-app/live/`
- Rider: `https://baccarisverige-ux.github.io/movera-rider-app/live/`

`CORS_ORIGINS` (in `render.yaml`) lets these pages call the server. `ADMIN_PANEL_URL` makes the password link open
the live admin.
