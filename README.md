# movera-server

The Movera backend: one server for the **rider** and **driver** apps (Flutter) and the **admin** panel (React).
It implements the shared contract in [`movera-contracts`](https://github.com/baccarisverige-ux/movera-contracts);
`contracts/` here is a byte-for-byte copy of a tagged version (now **v0.5.6**).

Long-term server, built first for the real test week: Stockholm zones, 2–3 drivers and riders, cash only, push
off, and test phone numbers that sign in with a fixed code instead of SMS (outside production only).

## Stack

TypeScript on Node 22, Fastify, PostgreSQL 16. One stateless container; the database holds all state.

## Run it

```sh
npm ci
npm run dev            # http://localhost:8080/healthz
npm test               # unit, API and database tests (needs PostgreSQL, see below)
npm run contract:verify
npm run migrate        # apply new migrations to DATABASE_URL
docker compose up --build   # server + PostgreSQL
```

Test week on Render: `render.yaml` and [`docs/DEPLOY_RENDER.md`](docs/DEPLOY_RENDER.md).

Settings come from the environment (`src/env.ts`):

| Variable | Meaning | Default |
|---|---|---|
| `MOVERA_ENV` | `development`, `staging` or `production`. Test sign-in numbers exist only outside production. | `production` (the safe side; `npm run dev` sets `development`) |
| `PORT`, `HOST` | Where the server listens | `8080`, `0.0.0.0` |
| `DATABASE_URL` | `postgres://user:pass@host:5432/db`. Required on staging and production. | none |
| `MIGRATE_ON_START` | Apply new migrations at start (instances take turns) | `true` |
| `DATABASE_POOL_MAX` | Connections per instance | `10` |
| `JWT_SECRET` | Signs access tokens, at least 32 characters. Required on staging and production. | random per start |
| `OSRM_URL` | Movera's own route service (e.g. `http://osrm:5000`). Unset: distances are estimated | none |
| `GOOGLE_MAPS_API_KEY` | Address search through Google. Unset: address search answers `503` | none |
| `FIREBASE_SERVICE_ACCOUNT` | Push (contract v0.18.3 R7): the Firebase service account JSON. Every bell notice is also sent through FCM HTTP v1 after its command commits (one retry; dead tokens removed; riders with `consents.rideUpdates` false get none), and `GET /push/config?app=driver\|rider` serves the public web config of the Firebase web apps "Movera Driver web" / "Movera Rider web". Never logged. Unset or unusable: push is off | none |
| `APPLE_CLIENT_IDS`, `GOOGLE_CLIENT_IDS` | Apple / Google sign-in (contract §8): the client ids the apps' identity tokens are issued for, comma-separated (Apple: bundle ids / service id; Google: OAuth client ids). Unset: that provider answers `503` `provider_not_configured` and the apps show the button as coming soon | none |
| `DRIVER_APP_LINK` | Install link added to the SMS when a fleet owner invites a number that has no account yet | none |
| `DOCUMENT_FILES_KEY` | Seals uploaded driver documents at rest (AES-256-GCM): 32 random bytes, base64 (`openssl rand -base64 32`). Required in production; elsewhere a key derived from `JWT_SECRET` stands in | derived outside production |
| `ADMIN_PANEL_URL` | Where setup links point | `http://localhost:5173` |
| `DEFAULT_ZONE_ID` | Zone for settings when an app names none | `Z001` |
| `TRUST_PROXY_HOPS` | Proxies in front of the server (the host's load balancer = 1), so limits see the phone's real address and it cannot be faked | `0` |
| `CORS_ORIGINS` | Web pages on another site that may call the API from a browser (the apps' web builds), e.g. `https://owner.github.io`. Unset: none | none |
| `SEED_TEST_ON_START` | `true`: at start, make the test accounts once and publish sample settings where a zone has none (a host without a shell; not in production) | `false` |
| `ADMIN_BOOTSTRAP_EMAIL`, `ADMIN_BOOTSTRAP_NAME` | At start, make this Super admin and write its password link to the log while it has no password (not in production) | none |
| `ADMIN_TEST_EMAIL`, `ADMIN_TEST_NAME`, `ADMIN_TEST_PASSWORD_RESET` | A second Super admin for automated checks, made at start the same way: kept if it exists, password link in the log while it has no password, any new reset text gives one new link (not in production) | none |
| `MOVERA_EXTRA_TEST_PHONES` | Big test: more test numbers than the six built in, comma list of numbers and ranges (`+46701740611-+46701740660,+33639980001`), both ends included, at most 1000; seeded at start for both apps with the fixed code (not in production) | none |
| `LOG_LEVEL` | `info`, `debug`, … | `info` |

Tests use `TEST_DATABASE_URL` (default `postgres://movera:movera@127.0.0.1:5432/movera`, the compose database).
The run builds a template database with every migration, and each test file gets its own copy.

## The contract

- Every operation lives under `/api/v1` (contract `servers`); `/healthz` and `/readyz` sit outside it.
- Every response carries `X-Request-Id` (the client's, or a new one) and `X-Api-Version: 0.5`. A request that
  sends another API version gets `400 invalid_request`, reason `unsupported_api_version`.
- Errors are the contract's `Error`: `{ code, message, requestId, retryable, reason?, projection? }`.
- An operation the server does not serve yet answers `404 not_found`, reason `operation_not_enabled`.

Update the contract copy with `tools/sync_contract.sh <tag>`; `test/contract_copy.test.ts` fails on any drift.

## Database rules

- Migrations live in `migrations/NNNN_name.sql` and are append-only: an applied file that changes stops the
  server. The database's allowed values (trip statuses, event kinds, …) are checked against the contract by
  `test/db/schema_contract.test.ts`.
- Every change runs in one transaction with its `Idempotency-Key` (`src/http/idempotency.ts`): the same key and
  request replays the first answer, the same key with a different request is `409 conflict`
  (`idempotency_key_reused`), and a failed attempt keeps nothing, so it can be retried.
- Trip commands lock the trip row, check `expectedVersion` (`409 version_mismatch` with the projection), and
  append one realtime event with the next per-trip `sequence` (`src/db/tripLog.ts`). Lock order: trip, offer,
  driver. Driver locations live in their own table so they never wait on a command.
- Timers (offer expiry, dispatch steps, …) are rows written with the change that needs them
  (`src/jobs/timers.ts`). Any instance may run them; each runs once, a failure is undone and retried with a
  growing delay, and after 8 failures it is parked and logged.

## Sign-in (contract §8)

- Test numbers (`src/auth/testPhones.ts`, owner decision 1) sign in with the fixed code `1234`, only outside
  production. Any other number is `403 forbidden`, reason `sign_in_restricted`, until an SMS provider exists.
- Codes: 4 digits, 5 minutes, 5 tries, a new one after 30 s, at most 10 per number per hour. Only hashes are stored.
- Access token: 15-minute JWT (HS256, `JWT_SECRET`); its session is checked on every call, so sign-out works at once.
- Refresh token: opaque, 30 days, rotated on every refresh. A token used twice ends the session, except the same
  token again within a minute (an answer lost on a bad connection).
- Apple / Google (v0.5.3): `POST /auth/provider` checks the identity token against the provider's published keys
  and the owner's client ids. A linked identity signs in at once; a new one gets `PHONE_REQUIRED` with a link token
  (15 minutes) and the names / e-mail the provider gave; the phone is then verified once with that token and the
  account (found or made by the phone) is linked. Without client ids the provider is not configured (`503`).
- Waiting list (v0.15.0, owner 2026-10-29): a restricted number can `POST /auth/waitlist { phone, app, locale? }`
  (one row per phone and app in `sign_in_waitlist`, 30 asks per address an hour); admins read `GET /admin/waitlist`.
- Test accounts (v0.15.0): `GET /auth/test-accounts` lists the test numbers with each account's status, for the
  staging builds' sign-in screen. The route exists only outside production (production answers `404`).
- Crashes & errors (v0.16.0, owner 2026-10-29): `POST /telemetry/crashes` reports that name `app` and `platform` (or
  carry a rider/driver token) are grouped in `error_groups` by app + platform + normalized message + top stack frame;
  the server's own unhandled 5xx errors are recorded as app `server`, scrubbed. Any signed-in admin (every role) reads
  `GET /admin/errors` and mark groups with `PATCH /admin/errors/{id}`; a fixed group that occurs again reopens.
  At most 200 reports are kept per group; groups not seen for 30 days are deleted.
- SMS: there is no provider yet (the owner picks 46elks or Twilio). Every message the server wants sent (fleet
  invitations today) is written to `sms_outbox`, as `skipped` while no provider exists, so nothing is lost.

## Admin sign-in and settings (contract §9, §6)

- `npm run admin -- create --email <e-mail> --name "<name>" --role super` creates an admin and prints a one-time
  link (72 h) to choose the password; `npm run admin -- link --email <e-mail>` makes a new one. In the container:
  `node dist/admin/cli.js …`.
- `npm run admin -- driver --phone +46701740605 --name Sara --make Volvo --model V60 --color Black --plate ABC123
  --categories economy` creates an approved test driver with an approved car, in every open zone.
- `npm run admin -- seed-test` (staging and development only) makes the test week's ready accounts on the test
  numbers: three activated drivers in the approved fleet "Movera Test AB" (code `MV-TESTA`), each with an approved
  car and every document approved, and three active riders; all sign in with the fixed code `1234`. It also publishes
  the contract's sample settings (prices, dispatch, both apps') in every open zone that has none yet. Running it again
  updates the same accounts; the testers' real numbers replace the placeholders in `src/drivers/seedTest.ts`.
- The admin panel saves a draft per document and zone (`PUT /admin/config/{doc}`), then publishes it. The server
  checks every document against the contract's schema and its zone, stamps the next `version` and `publishedAt`,
  keeps every version in `config_history`, and tells the apps (`config_published`). Pricing and dispatch are read by
  the server only.
- A Super admin publishes at once; anyone else's publish waits for a second admin (`/admin/approvals`, 24 h).
  Every change is written to `admin_audit`.

## Live updates (contract §4)

- `GET /trips/{tripId}/events` with `Accept: text/event-stream` is a live stream (`id:` = sequence, a heartbeat
  comment every 15 s); without it, the same path answers a JSON page. `?after=` or `Last-Event-ID` resumes.
- `GET /rider/config/stream` and `/driver/config/stream` send `config_published`.
- Trip chat: `POST /trips/{tripId}/messages { text }` (rider, driver; an admin writes as `support`) answers the
  `Message` and sends it on the trip's stream as a `message` event, with the trip's `version` unchanged;
  `GET /trips/{tripId}/messages?cursor&limit` pages the chat oldest first. Open from the moment a driver is on the
  trip until an hour after it ended (`409 invalid_transition`, reason `chat_closed`, otherwise). The other side also
  gets an in-app notice (`GET /notifications`, kind `trip_message`).
- One LISTEN connection per instance wakes the streams; each stream reads the events itself, so nothing is
  skipped or repeated, and it reconnects on its own. Who may see a trip is checked again on every event.

## Build plan

The server lands in small pull requests, each tested:

1. Skeleton: headers, error shape, health, contract copy, container, CI. *(done)*
2. Rule engines tested against the contract's own fixtures: money, trip transitions, realtime gate, cancel
   fees, pickup pay, surge. *(done)*
3. Database, idempotency, versioned commands, trip event log, timers. *(done)*
4. Sign-in: phone code with test numbers, tokens, push devices. *(done; admin sign-in comes with contract v0.5.1)*
5. Config documents and admin publish. *(done: admin sign-in, drafts, publish, second-admin approvals, audit)*
6. Places, routes and quotes. *(done: fare engine on the contract's 17 cases, POST /quotes, address search, routes)*
7. Trips: request, read, rider profile, cash payment. *(done: book from a quote, read, lists, active, cancel before a driver, cancel reason, events replay, /rides aliases, profile, cash, account deletion)*
8. Live updates (SSE). *(done: trip events and config_published streams, resume, per-viewer redaction)*
9. Driver availability and location. *(done: online/offline, location batches, trip traces, cars, admin live map)*
10. Dispatch: offers, accept, decline, admin assign and radar groups. *(done: automatic dispatch, offers, accept/decline, offer feed, keep-waiting, dispatch control; admin assign and radar groups come with step 12)*
11. Trip steps, cancel, fees, waiting, no-show, rating.
12. Admin lists, commands and audit.
13. Staging deploy, seed data, end-to-end run with all three apps.
