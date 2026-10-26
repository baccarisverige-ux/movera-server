# movera-server baseline audit (Phase 1), 2026-10

Base: `origin/main` @ 5e6edc7. Documentation only; no source, test or workflow changes.

## Done / Not done yet
- [x] 1. Structure and architecture
- [ ] 2. Dependencies
- [ ] 3. CI
- [ ] 4. Baseline run
- [ ] 5. Coverage of critical logic
- [ ] 6. Route inventory
- [ ] 7. Code quality findings
- [ ] 8. Known open issues and stale branches
- [ ] 9. Untested features and risks
- [ ] 10. Summary table

## 1. Structure and architecture

Size: 80 files in `src/` (~9.6k lines incl. schema), 45 files in `test/`, 15 SQL migrations; total `src+test+migrations` = 19,283 lines (`wc -l`).
Largest files: `src/db/schema.ts` 697, `src/trips/ride.ts` 659, `src/dispatch/runtime.ts` 632, `src/auth/service.ts` 502, `src/drivers/service.ts` 437, `src/admin/trips.ts` 355, `src/drivers/invitations.ts` 352.

| Module (`src/…`) | Role |
|---|---|
| `main.ts` | Process entry: env → pool → `migrate()` if `MIGRATE_ON_START` → `NotificationHub` (LISTEN) → `buildApp` → maintenance timers, test phones (non-prod), `prepareTestWeek`, `TimerWorker` (main.ts:20-42). SIGINT/SIGTERM close in order app → worker → hub → db. |
| `app.ts` | Fastify instance: request id, JSON parser (empty body = no body), multipart (10 MB, 1 file), CORS allow-list hook, `X-Api-Version` check, central error handler mapping to contract errors, `/healthz`, `/readyz`, and registration of every route module (app.ts:139-167). Routes are only registered when a DB is present. |
| `env.ts` | Zod schema of all settings; `MOVERA_ENV` defaults to `production` (safe side); superRefine requires `DATABASE_URL`, `JWT_SECRET` outside development and `DOCUMENT_FILES_KEY` in production; forbids `SEED_TEST_ON_START`/`ADMIN_BOOTSTRAP_EMAIL` in production (env.ts:85-100). Settings: MOVERA_ENV, HOST, PORT, LOG_LEVEL, DATABASE_URL, MIGRATE_ON_START, DATABASE_POOL_MAX, JWT_SECRET, OSRM_URL, GOOGLE_MAPS_API_KEY, DOCUMENT_FILES_KEY, APPLE_CLIENT_IDS, GOOGLE_CLIENT_IDS, DRIVER_APP_LINK, PAYMENT_METHODS, DEFAULT_ZONE_ID, ADMIN_PANEL_URL, TRUST_PROXY_HOPS, SEED_TEST_ON_START, ADMIN_BOOTSTRAP_EMAIL/NAME, CORS_ORIGINS. (Cosmetic: the CORS_ORIGINS doc comment sits above SEED_TEST_ON_START, env.ts:66-71.) |
| `auth/` | `guard.ts` `authenticate(request, deps, actors)` (bearer JWT, actor allow-list, live-session check) and `authenticateAdmin(…, permission)`; `jwt.ts` HS-signed access tokens; `service.ts` OTP, sessions, refresh; `provider.ts` Apple/Google id-token verification; `testPhones.ts`. |
| `admin/` | Admin auth (password, setup links), `permissions.ts`, people/approvals/lists/trip routes, CLI (`npm run admin`). |
| `rules/` | Pure logic: `transitions.ts` (table loaded from `contracts/contract.json` and cross-checked at import, transitions.ts:123-125), `fare.ts` `priceFare`, `cancelFees.ts`, `money.ts`, `fraction.ts`, `surge.ts`, `pickupPay.ts`, `realtimeGate.ts`. |
| `trips/` | `routes.ts` (rider trip commands), `rideRoutes.ts` (driver ride commands), `service.ts`, `ride.ts` (arrive/start/complete/cancel/end-early, fees, near-dropoff timer), `commands.ts` `applyCommand` — the single place that changes trip status (21 call sites; no other `status` write on `trips` found by grep), `projection.ts`, `messages.ts`. |
| `dispatch/` | `engine.ts` pure (radius, busy, modes), `runtime.ts` DB side (rounds, offers, claim/decline, withdraw; timer kinds `dispatch_round`, `search_step`, `search_end`, `withdraw_driver_offers`), `routes.ts`. |
| `drivers/`, `documents/` | Onboarding, fleets, invitations, vehicles; documents sealed with AES-256-GCM (`documents/files.ts`). |
| `quotes/`, `maps/`, `config/`, `riders/`, `notifications/`, `sms/` | Quotes (OSRM or estimate router), places (Google or none), published config/zone lookup, wallet and nearby drivers, in-app notifications, SMS outbox (no provider yet). |
| `realtime/` | `hub.ts` one LISTEN connection per instance on `trip_events`, `config_published`, offer channel; `sse.ts` SSE with 15 s heartbeat and shutdown close; `streams.ts` replay from `trip_events` by sequence (`Last-Event-ID`). NOTIFY is sent inside the writing transaction (`db/tripLog.ts:100`, `dispatch/runtime.ts:251`, `config/service.ts:127`), so streams see only committed changes. |
| `jobs/` | `timers.ts` durable timers table, `FOR UPDATE SKIP LOCKED`, backoff 1 s→5 min, park after 8 attempts, `TimerBusy` for NOWAIT locks; `maintenance.ts` hourly sweep of idempotency keys (24 h), GPS traces (30 d), unused quotes. |
| `http/` | `errors.ts` ApiError, `idempotency.ts` `runIdempotent` (key row inserted in the command's transaction; replay on same hash, 409 on reuse; only 2xx stored), `validate.ts`, `prefix.ts`. |
| `db/` | Kysely `schema.ts`, `migrate.ts` (SQL files in `migrations/`, applied in order), `tripLog.ts` (`lockTrip`, `appendTripEvent`). |

Layering: routes call `authenticate*` then `runIdempotent` (mutations) and a service/command function inside the transaction; services use Kysely directly (no repository layer). Pure rules (`rules/`, `dispatch/engine.ts`) have no DB access.

Migrations: `0001_foundation` … `0015_stockholm_south` (15 files). Deploy: `render.yaml`, `Dockerfile`, `compose.yaml` (local Postgres).
