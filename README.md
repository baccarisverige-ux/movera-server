# movera-server

The Movera backend: one server for the **rider** and **driver** apps (Flutter) and the **admin** panel (React).
It implements the shared contract in [`movera-contracts`](https://github.com/baccarisverige-ux/movera-contracts);
`contracts/` here is a byte-for-byte copy of a tagged version (now **v0.5.1**).

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
| `ADMIN_PANEL_URL` | Where setup links point | `http://localhost:5173` |
| `DEFAULT_ZONE_ID` | Zone for settings when an app names none | `Z001` |
| `TRUST_PROXY_HOPS` | Proxies in front of the server (the host's load balancer = 1), so limits see the phone's real address and it cannot be faked | `0` |
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

## Admin sign-in and settings (contract §9, §6)

- `npm run admin -- create --email <e-mail> --name "<name>" --role super` creates an admin and prints a one-time
  link (72 h) to choose the password; `npm run admin -- link --email <e-mail>` makes a new one. In the container:
  `node dist/admin/cli.js …`.
- `npm run admin -- driver --phone +46701740605 --name Sara --make Volvo --model V60 --color Black --plate ABC123
  --categories economy` creates an approved test driver with an approved car, in every open zone.
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
