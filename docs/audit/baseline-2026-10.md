# movera-server baseline audit (Phase 1), 2026-10

Base: `origin/main` @ 5e6edc7. Documentation only; no source, test or workflow changes.

## Done / Not done yet
- [x] 1. Structure and architecture
- [x] 2. Dependencies
- [x] 3. CI
- [ ] 4. Baseline run
- [ ] 5. Coverage of critical logic
- [x] 6. Route inventory
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

## 2. Dependencies

Installed (`npm ls --depth=0`, lockfile from `npm ci`):

| Package | Version | Kind | Import sites in `src/` (grep `from "<pkg>`) |
|---|---|---|---|
| fastify | 5.12.7 | prod | 16 files |
| @fastify/multipart | 10.1.6 | prod | 1 (app.ts) |
| fastify-plugin | 5.1.0 | prod | **0 — not imported anywhere in src/, test/ or tools/ → unused** |
| kysely | 0.28.18 | prod | 24 |
| pg | 8.23.1 | prod | 3 |
| zod | 3.25.76 | prod | 13 (request bodies + env) |
| ajv / ajv-formats | 8.20.0 / 3.0.1 | prod | 1 (`contract/schemas.ts`) |
| yaml | 2.9.1 | prod | 1 (`contract/schemas.ts`) |
| @node-rs/argon2 | 2.2.2 | prod | 1 (admin passwords) |
| typescript, tsx, vitest, @types/node, @types/pg | 5.9.3, 4.23.15, 3.2.7, 22.20.5, 8.23.1 | dev | — |

No coverage provider installed (`@vitest/coverage-v8` / `-istanbul` absent from `node_modules/@vitest/`).

`npm outdated` (major behind): zod 3→4.6.7, vitest 3→5.0.5, kysely 0.28→0.29.7, typescript 5.9→7.0.2, fastify-plugin 5→6, @types/node 22→26 (Node 22 is the runtime, so 22 types are correct).

### npm audit (2026-10-26)
| Command | Critical | High | Moderate | Low | Packages |
|---|---|---|---|---|---|
| `npm audit --omit=dev` | 0 | **1** | 0 | 0 | `zod <4.6.6` — GHSA-mrhx-c7xc-m3w5, memory exhaustion validating oversized constrained collections. Fix only in zod 4 (breaking). Runtime-relevant: zod validates request bodies. Mitigated in part by Fastify `bodyLimit` 1 MB (app.ts:46); not measured. |
| `npm audit` (all) | **2** | 1 | 1 | 0 | `tinypool <=2.1.1` (critical, GHSA-5gmw-xhrv-c9v3, GHSA-85c8-ppgw-ccpr) and `vitest` (counted critical via tinypool), `@vitest/mocker <=4.1.11` (moderate, GHSA-82fw-gwwq-j7x9, GHSA-qxg6-89mg-rqv8), zod (high). Dev-only except zod; fix = vitest 5 (breaking). |

## 3. CI

One workflow: `.github/workflows/ci.yml` ("CI"), on every `pull_request` and on `push` to `main`. One job `checks` on `ubuntu-latest` with a `postgres:16` service (health-checked), `TEST_DATABASE_URL` set. Steps: checkout@v4 → setup-node@v4 (Node 22, `cache: npm`) → `npm ci` → `npm run contract:verify` (sha256 of `contracts/` against `contracts/CHECKSUMS`) → `npm run typecheck` → `npm test` → `npm run build`.

History (`gh run list -L 100`): 61 success, 2 failure. The last 10 runs each took about 1 m 50 s – 2 m 10 s (createdAt → updatedAt).

Gap against the plan's Phase 2 server column:

| Check | Present? | Evidence |
|---|---|---|
| Lockfile install `npm ci` | yes | ci.yml step |
| Format (Prettier) | **no** | no Prettier config or script in repo |
| Static analysis `tsc --noEmit` | yes | `npm run typecheck` |
| ESLint | **no** | no eslint config, not in devDependencies |
| Unit tests + Postgres service | yes | `npm test` with postgres:16 service |
| Coverage report | **no** | no coverage provider installed, no coverage step |
| Build | yes | `npm run build` |
| E2E API scenarios | partial | route-level tests via `app.inject` exist in `test/`; no separate e2e harness (`test/e2e/` absent) |
| Security: `npm audit` | **no** | not in workflow (currently would fail: see §2) |
| Secret scan | **no** | none |
| Caching | yes (npm) | `cache: npm` |
| Job timeout | **no** | no `timeout-minutes` (default 360 min) |
| Concurrency cancel of superseded runs | **no** | no `concurrency:` block |
| `permissions:` least privilege | **no** | not declared |
| Required checks / branch protection on `main` | NOT VERIFIED | `gh api …/branches/main/protection` → HTTP 403 "Resource not accessible by integration"; owner decision D1 |

## 6. Route inventory

Built by reading every `app.get/post/put/patch/delete` call (112 registrations, loops expanded below). Paths are under `/api/v1` unless shown as `/healthz` / `/readyz`. "zone" = `adminCoversZone` or a zone filter. Line numbers are the registration line (approximate within a loop). Cross-checked against the contract's `x-permission`: NOT VERIFIED (Phase 4).

| Method | Path | Actor / guard | Idempotency-Key | Where |
|---|---|---|---|---|
| GET | `/healthz` | public | n/a | app.ts:127 |
| GET | `/readyz` | public | n/a | app.ts:129 |
| POST | `/auth/otp/request` | public (rate limits per phone/IP, auth/service.ts:115-129) | no (pre-auth) | auth/routes.ts:42 |
| POST | `/auth/otp/verify` | public (attempt limit, auth/service.ts:199) | no (pre-auth) | auth/routes.ts:47 |
| POST | `/auth/provider` | public | no (pre-auth) | auth/routes.ts:53 |
| POST | `/auth/refresh` | public (refresh token) | no | auth/routes.ts:58 |
| POST | `/auth/sign-out` | rider, driver (ended session allowed) | no (naturally repeatable, 204) | auth/routes.ts:63 |
| POST | `/push/devices` | rider, driver | yes | auth/routes.ts:70 |
| POST | `/push/devices/unregister` | rider, driver (ended session allowed) | yes | auth/routes.ts:100 |
| GET | `/notifications` | rider, driver | n/a | notifications/routes.ts:27 |
| POST | `/notifications/{notificationId}/read` | rider, driver | **no** | notifications/routes.ts:33 |
| POST | `/admin/auth/sign-in` | public (lockout, admin/auth.ts:116-121) | no (pre-auth) | admin/routes.ts:25 |
| POST | `/admin/auth/setup-password/check` | public (setup token) | no | admin/routes.ts:27 |
| POST | `/admin/auth/setup-password` | public (setup token) | no | admin/routes.ts:29 |
| POST | `/admin/auth/refresh` | public (refresh token) | no | admin/routes.ts:31 |
| POST | `/admin/auth/sign-out` | admin (ended session allowed) | no | admin/routes.ts:33 |
| GET | `/admin/auth/me` | admin (any) | n/a | admin/routes.ts:39 |
| POST | `/admin/agents/{adminId}/setup-link` | admin `team.edit` | key required, answer deliberately not stored (holds a live link) | admin/routes.ts:44 |
| GET | `/rider/config, /driver/config` | rider / driver | n/a | config/routes.ts:66-67 |
| GET | `/rider/config/stream, /driver/config/stream (SSE)` | rider / driver | n/a | config/routes.ts:81-82 |
| GET | `/admin/config/{doc}` | admin `settings.read` + zone | n/a | config/routes.ts:84 |
| PUT | `/admin/config/{doc}` | admin EDIT_PERMISSION[doc] + zone | yes | config/routes.ts:92 |
| POST | `/admin/config/{doc}/publish` | admin PUBLISH_PERMISSION[doc] + zone; second-admin approval | yes | config/routes.ts:105 |
| GET | `/admin/approvals` | admin `approval.decide` (no zone filter on the list) | n/a | config/routes.ts:131 |
| POST | `/admin/approvals/{approvalId}/approve, /reject` | admin; permission, own-request and zone checked inside (approvals.ts:112-116) | yes | config/routes.ts:139 |
| POST | `/quotes` | rider | yes | quotes/routes.ts:13 |
| POST | `/trips` | rider | yes | trips/routes.ts:60 |
| GET | `/trips/{tripId}` | rider, driver, admin (ownership in getTrip) | n/a | trips/routes.ts:71 |
| GET | `/rides/{rideId} (alias)` | rider | n/a | trips/routes.ts:71 |
| POST | `/trips/{tripId}/cancel` | rider or driver | yes | trips/routes.ts:77 |
| POST | `/rides/{rideId}/cancel (alias)` | rider | yes (same key space as /trips) | trips/routes.ts:77 |
| POST | `/trips/{tripId}/cancel-reason` | rider | yes | trips/routes.ts:90 |
| POST | `/trips/{tripId}/raise-price` | rider (body not schema-parsed at route, `as never`) | yes | trips/routes.ts:98 |
| POST | `/trips/{tripId}/on-the-way` | rider | yes | trips/routes.ts:104 |
| GET | `/trips/{tripId}/events (JSON or SSE)` | rider, driver, admin (getTrip ownership check first) | n/a | trips/routes.ts:111 |
| GET | `/trips/{tripId}/messages` | rider, driver, admin | n/a | trips/routes.ts:133 |
| POST | `/trips/{tripId}/messages` | rider, driver, admin | yes | trips/routes.ts:140 |
| GET | `/rider/trips/active` | rider | n/a | trips/routes.ts:147 |
| GET | `/rider/trips` | rider | n/a | trips/routes.ts:153 |
| GET | `/rider/profile` | rider | n/a | trips/routes.ts:160 |
| GET | `/rider/nearby-vehicles` | rider | n/a | trips/routes.ts:166 |
| PATCH | `/rider/profile` | rider | yes | trips/routes.ts:172 |
| GET | `/payment-methods` | rider | n/a | trips/routes.ts:180 |
| POST | `/payment-methods` | rider (always 400) | no (no state change) | trips/routes.ts:184 |
| POST | `/payment-methods/default` | rider | yes (no state change) | trips/routes.ts:188 |
| POST | `/account/deletion` | rider | yes | trips/routes.ts:196 |
| POST | `/trips/{tripId}/head-to-pickup, /arrive, /board, /start` | driver | yes | trips/rideRoutes.ts:45 |
| POST | `/trips/{tripId}/complete` | driver | yes | trips/rideRoutes.ts:53 |
| POST | `/trips/{tripId}/no-show` | driver | yes | trips/rideRoutes.ts:60 |
| POST | `/trips/{tripId}/end-early` | rider (body `as never` at route) | yes | trips/rideRoutes.ts:67 |
| POST | `/trips/{tripId}/rating` | rider, driver | yes | trips/rideRoutes.ts:73 |
| GET | `/driver/earnings` | driver | n/a | trips/rideRoutes.ts:81 |
| GET | `/driver/offers` | driver (own offers) | n/a | dispatch/routes.ts:63 |
| GET | `/driver/offers/stream (JSON or SSE)` | driver | n/a | dispatch/routes.ts:75 |
| POST | `/offers/{offerId}/accept` | driver | yes | dispatch/routes.ts:119 |
| POST | `/offers/{offerId}/decline` | driver | yes | dispatch/routes.ts:127 |
| POST | `/trips/{tripId}/keep-waiting` | rider | yes | dispatch/routes.ts:135 |
| GET | `/admin/zones/{zoneId}/dispatch-control` | admin `trips.read` + zone | n/a | dispatch/routes.ts:150 |
| PUT | `/admin/zones/{zoneId}/dispatch-control` | admin `dispatch.edit` + zone; pause/force needs approval | yes | dispatch/routes.ts:158 |
| GET | `/driver/profile` | driver | n/a | drivers/routes.ts:37 |
| PATCH | `/driver/profile` | driver | yes | drivers/routes.ts:42 |
| POST | `/driver/availability` | driver | yes | drivers/routes.ts:47 |
| POST | `/driver/location` | driver | yes | drivers/routes.ts:53 |
| GET | `/driver/vehicles` | driver | n/a | drivers/routes.ts:58 |
| POST | `/driver/vehicles` | driver | yes | drivers/routes.ts:63 |
| POST | `/driver/onboarding` | driver | yes | drivers/routes.ts:79 |
| GET | `/driver/fleet` | driver | n/a | drivers/routes.ts:83 |
| POST | `/driver/fleet/join` | driver (join-attempt limit, invitations.ts:129) | yes | drivers/routes.ts:88 |
| POST | `/driver/fleet/invite` | driver (owner check in service) | yes | drivers/routes.ts:96 |
| GET | `/driver/fleet/invitations` | driver | n/a | drivers/routes.ts:104 |
| POST | `/driver/fleet/invitations/{invitationId}/accept, /decline, /cancel` | driver | yes | drivers/routes.ts:109 |
| POST | `/driver/fleet/leave` | driver | yes | drivers/routes.ts:115 |
| POST | `/driver/fleet/drivers/{driverId}/remove` | driver (owner check in service) | yes | drivers/routes.ts:119 |
| GET | `/driver/fleet/earnings` | driver | n/a | drivers/routes.ts:128 |
| GET | `/driver/documents` | driver | n/a | drivers/routes.ts:133 |
| POST | `/driver/documents (multipart ≤10 MB)` | driver | yes (hash of a file summary, not the bytes) | drivers/routes.ts:139 |
| GET | `/driver/documents/{documentId}/file` | driver (own) | n/a | drivers/routes.ts:146 |
| GET | `/admin/live/drivers` | admin `trips.read` + zone | n/a | drivers/routes.ts:153 |
| GET | `/admin/trips/{tripId}/trace` | admin `trips.read` + zone | n/a | drivers/routes.ts:160 |
| GET | `/admin/fleets, /admin/fleets/{fleetId}` | admin `drivers.read` (zone in service) | n/a | admin/peopleRoutes.ts:47,51 |
| POST | `/admin/fleets/{fleetId}/review, /code` | admin `drivers.activate` | yes | admin/peopleRoutes.ts:55,61 |
| POST | `/admin/fleets/{fleetId}/drivers/{driverId}/remove` | admin `drivers.activate` | yes | admin/peopleRoutes.ts:67 |
| POST | `/admin/fleets/{fleetId}/invitations/{invitationId}/accept, /cancel` | admin `drivers.activate` | yes | admin/peopleRoutes.ts:79 |
| GET | `/admin/drivers/{driverId}` | admin `drivers.read` + zone | n/a | admin/peopleRoutes.ts:87 |
| GET | `/admin/vehicles` | admin `drivers.read` + zone (filtered after read) | n/a | admin/peopleRoutes.ts:95 |
| POST | `/admin/vehicles/{vehicleId}/review` | admin `vehicles.edit` + zone | yes | admin/peopleRoutes.ts:99 |
| POST | `/admin/documents/{documentId}/review` | admin `documents.approve` | yes | admin/peopleRoutes.ts:107 |
| GET | `/admin/documents/{documentId}/file` | admin `documents.approve` | n/a (runs in a transaction) | admin/peopleRoutes.ts:113 |
| GET | `/admin/trips, /admin/trips/{tripId}, /offers, /nearby-drivers` | admin `trips.read` + zone | n/a | admin/tripRoutes.ts:58-71 |
| GET | `/admin/riders` | admin `riders.read` (no zone filter; riders are not zoned) | n/a | admin/tripRoutes.ts:76 |
| GET | `/admin/drivers` | admin `drivers.read` + zone | n/a | admin/tripRoutes.ts:80 |
| GET | `/admin/payments, /admin/refunds/payouts` | admin `finance.read` + zone | n/a | admin/tripRoutes.ts:84,92 |
| GET | `/admin/audit` | admin `audit.read` | n/a | admin/tripRoutes.ts:88 |
| POST | `/admin/trips/{tripId}/cancel, /reassign, /assign, /radar-group, /no-show, /complete, /driver-bonus, /adjust` | admin `trips.intervene` | yes | admin/tripRoutes.ts:99-131 |
| POST | `/admin/trips/{tripId}/refund` | admin `payments.refund` | yes | admin/tripRoutes.ts:132 |
| POST | `/admin/refunds/{refundId}/paid` | admin `finance.edit` | yes | admin/tripRoutes.ts:123 |
| POST | `/admin/drivers/{driverId}/status` | admin `drivers.activate` | yes | admin/tripRoutes.ts:131 |
| POST | `/admin/riders/{riderId}/status` | admin `riders.block` | yes | admin/tripRoutes.ts:137 |
| GET | `/wallet, /wallet/entries, /rider/refunds` | rider | n/a | admin/tripRoutes.ts:145-153 |
| POST | `/rider/refunds/{refundId}/destination` | rider | yes | admin/tripRoutes.ts:157 |
| POST | `/locations/autocomplete` | rider | n/a (read) | maps/routes.ts:56 |
| POST | `/locations/geocode` | rider | n/a (read) | maps/routes.ts:71 |
| POST | `/locations/reverse-geocode` | rider, driver | n/a (read) | maps/routes.ts:82 |
| POST | `/routes` | rider, driver | n/a (read) | maps/routes.ts:91 |
| GET | `/routes/driving/{coordinates}` | driver (in-memory 1-minute rate limit) | n/a | maps/routes.ts:100 |

**Flags**
- Routes without an auth guard: only `/healthz`, `/readyz`, `auth/otp/*`, `auth/provider`, `auth/refresh`, `admin/auth/sign-in`, `admin/auth/setup-password[/check]`, `admin/auth/refresh` — all pre-sign-in by design. No authenticated-looking route lacks a guard.
- State change without idempotency: `POST /notifications/{id}/read` (repeat-safe by nature, S4); the sign-in/refresh/sign-out family (by design); `POST /admin/agents/{id}/setup-link` (key checked, reply not stored, by design).
- Route-level body validation skipped (`request.body as never` / cast, validation left to the service): `raise-price` (trips/routes.ts:101), `end-early` (rideRoutes.ts:70), `locations/*` and `routes` (cast then `check()` against the contract schema, maps/routes.ts:58-93). Whether every service validates fully is NOT VERIFIED here (Phase 4).
- `GET /admin/approvals` is not filtered by the admin's zones (config/routes.ts:131-136): a zone-scoped admin sees other zones' pending approvals (cannot decide them, approvals.ts:116). S3.
- `GET /driver/offers` does one trip query per offer (N+1, dispatch/routes.ts:67-70). S4.
- Rate limits on `/routes/driving` and the Places session map are in-process `Map`s keyed by subject that are never pruned (maps/routes.ts:30-31): per-instance only, and grow with the number of distinct users until restart. S4.
