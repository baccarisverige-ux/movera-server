# movera-server

The Movera backend: one server for the **rider** and **driver** apps (Flutter) and the **admin** panel (React).
It implements the shared contract in [`movera-contracts`](https://github.com/baccarisverige-ux/movera-contracts);
`contracts/` here is a byte-for-byte copy of a tagged version (now **v0.5.0**).

Long-term server, built first for the real test week: Stockholm zones, 2–3 drivers and riders, cash only, push
off, and test phone numbers that sign in with a fixed code instead of SMS (outside production only).

## Stack

TypeScript on Node 22, Fastify, PostgreSQL 16. One stateless container; the database holds all state.

## Run it

```sh
npm ci
npm run dev            # http://localhost:8080/healthz
npm test               # unit and API tests
npm run contract:verify
docker compose up --build   # server + PostgreSQL
```

Settings come from the environment (`src/env.ts`):

| Variable | Meaning | Default |
|---|---|---|
| `MOVERA_ENV` | `development`, `staging` or `production`. Test sign-in numbers exist only outside production. | `development` |
| `PORT`, `HOST` | Where the server listens | `8080`, `0.0.0.0` |
| `DATABASE_URL` | `postgres://user:pass@host:5432/db` | none yet |
| `LOG_LEVEL` | `info`, `debug`, … | `info` |

## The contract

- Every operation lives under `/api/v1` (contract `servers`); `/healthz` and `/readyz` sit outside it.
- Every response carries `X-Request-Id` (the client's, or a new one) and `X-Api-Version: 0.5`. A request that
  sends another API version gets `400 invalid_request`, reason `unsupported_api_version`.
- Errors are the contract's `Error`: `{ code, message, requestId, retryable, reason?, projection? }`.
- An operation the server does not serve yet answers `404 not_found`, reason `operation_not_enabled`.

Update the contract copy with `tools/sync_contract.sh <tag>`; `test/contract_copy.test.ts` fails on any drift.

## Build plan

The server lands in small pull requests, each tested:

1. Skeleton: headers, error shape, health, contract copy, container, CI. *(this)*
2. Rule engines tested against the contract's own fixtures: money, trip transitions, realtime gate, cancel
   fees, pickup pay, surge.
3. Database, idempotency, versioned commands, trip event log, timers.
4. Sign-in: phone code with test numbers, tokens, push devices, admin sign-in.
5. Config documents and admin publish.
6. Places, routes and quotes.
7. Trips: request, read, rider profile, cash payment.
8. Live updates (SSE).
9. Driver availability and location.
10. Dispatch: offers, accept, decline, admin assign and radar groups.
11. Trip steps, cancel, fees, waiting, no-show, rating.
12. Admin lists, commands and audit.
13. Staging deploy, seed data, end-to-end run with all three apps.
