# Audit Phase 4 — security and data integrity

Branch `audit/phase-4` (movera-server, movera-rider-app, Admin-panel-movera-dispatch). Plan:
`movera-contracts/docs/audit/AUDIT_PLAN.md` (Phase 4). Date 2026-10-26.

## What was checked, and how

| Area | How | Result |
|---|---|---|
| Role and zone checks on every route | `test/e2e/12_route_matrix.test.ts`: reads every route Fastify really serves (`printRoutes`), the expected callers from `contracts/openapi.yaml` (`x-actor`, `x-permission`, `security: []`), and calls each route with no token, with every app token it must refuse, as an admin whose role lacks the permission, and as a Super admin limited to Z002 on Z001 trips, drivers, fleets, cars, documents, zones, admins and approvals; owner-scoped routes also by another rider, another driver, and a fleet member who is not the owner. Valid bodies are sent, so each call reaches the owner / zone check instead of stopping at `400`. A route that is not in the contract fails the test until it is declared (4 server-only refund routes are, in `EXTRA`). | 1 hole found and fixed (P4-1) |
| Fares, transitions, documents, fleet links | Phase 3 e2e (raise cap, cash cap, terminal states, other rider / driver) plus new probes of admin money commands | P4-3 fixed; document reads and car picks were already covered (`test/drivers/onboarding.test.ts`) |
| Idempotency on money and state changes | Every mutating route read for `runIdempotent` | All money and state changes have it; `POST /notifications/{id}/read` does not (P4-12) |
| Rate limits | Sign-in (OTP per number / address, wrong codes; admin lock per e-mail / address): present. Join codes: present (10 an hour), regression test added. Uploads: none (P4-2, fixed). Telemetry: new (P4-5). | |
| Secrets in all five repositories and their whole history | `gitleaks` is not installed here and downloading it was not permitted, so `git log --all -p` of every repository was searched with gitleaks-style patterns (Google API keys, private keys, AWS / GitHub / Stripe / Slack tokens, `password|secret|api_key = "…"`, database URLs with a password) | Two Google Maps keys (P4-8); everything else is test placeholders |
| Logs: phone numbers, tokens, documents | Every server log statement read; the request log tested | P4-7 fixed; SMS logs show 4 digits only; tokens and document bytes are never logged; app logs go through `Observability.sanitize` |
| Dependency advisories | `npm audit` (server, admin). Flutter apps: no advisory source reachable from here (OSV blocked, Dependabot alerts off) | Server 0; admin 2 high (dev server only) fixed (P4-10); Flutter not checked |

## Findings

| Id | Sev | Repo | Finding | State |
|---|---|---|---|---|
| P4-1 | S2 | server | A Super admin limited to one zone could make a password link for an all-zones Super admin (the owner) and take the account over | **fixed** |
| P4-2 | S3 | server | Document uploads had no rate limit (each reads up to 10 MB into memory) | **fixed** (30 per driver and hour, `429 upload_limit`) |
| P4-3 | S3 | server | An admin could set a trip's fare below 0 (`adjust`, `complete`), giving negative driver earnings and commission | **fixed** (`400 invalid_amount`) |
| P4-4 | S2 | server, admin | Forgot admin password: once a password exists, no new link ever appears; Render's free plan has no shell | **fixed** (`ADMIN_PASSWORD_RESET`, help on the sign-in page); e-mail self-service proposed |
| P4-5 | S4 | server | `POST /telemetry/logs` (and `/analytics`, `/crashes`) in the contract but not served: app logs were lost | **fixed** |
| P4-6 | S4 | server | Riders have no home zone, so an admin limited to a zone lists and blocks every rider | open, owner decision |
| P4-7 | S3 | server | The request log kept the query string: admin searches `?q=+46…` or an e-mail landed in the log | **fixed** |
| P4-8 | S2 | rider, driver | Two Google Maps API keys in git history, one still at the tip of four branches | **owner must rotate** |
| P4-9 | S4 | rider | Live rider app called `GET /ride-types` and `GET /rider/promotions/active` (not in the contract, 404) | **fixed** (not called on the contract wire) |
| P4-10 | S3 | admin | `vite` 6.4.3 / `source-map-js` 1.2.1: 2 high advisories (dev server only) | **fixed** (lock file, vite 6.4.5) |
| P4-11 | S4 | server | `POST /admin/approvals/{id}/approve|reject` checks the permission after looking the approval up, so an admin without any decide permission can tell a real approval id (404 vs 403) | open (ids are random; low value) |
| P4-12 | S4 | server | `POST /notifications/{id}/read` takes no `Idempotency-Key` (contract: every mutation). Setting "read" twice changes nothing | open |
| P4-13 | S4 | server | `fleet_join_attempts`, `admin_sign_in_failures`, `document_upload_attempts` are never swept | open (small rows; add to the hourly sweep) |

### P4-1 — Password link for a wider-scoped admin (S2, fixed)

- **Steps.** Make a Super admin limited to Z002 (`admin create --role super`, zones Z002). Signed in as them,
  `POST /admin/agents/{ownerAdminId}/setup-link` → **201** with a live link; opening it sets the owner's password and
  ends the owner's sessions.
- **Root cause.** `src/admin/routes.ts` checked only `team.edit` (Super only); the target's zones were never compared
  with the caller's.
- **Fix.** The caller's zones must cover every zone of the target; an all-zones target needs an all-zones caller.
  Otherwise `403 forbidden`, reason `zone_out_of_scope` (403 is in the operation's responses).
- **Test.** `test/e2e/13_security.test.ts` "P4-1 …" failed before (`expected 201 to be 403`), passes after; the
  matrix (`12_route_matrix`) also failed before on `POST /admin/agents/:adminId/setup-link by a Z002 admin on Z001 →
  201`.

### P4-2 — Uploads without a rate limit (S3, fixed)

- **Steps.** A signed-in driver sends `POST /driver/documents` in a loop: every call is read into memory (up to
  10 MB), encrypted and stored; nothing stops it.
- **Fix.** Migration `0018_document_upload_attempts.sql`; the route counts the driver's uploads of the last hour
  before reading the file; above 30 → `429 rate_limited`, reason `upload_limit`, `Retry-After`. 30 covers a fleet
  owner's full set of person, company and several cars' documents with retries.
- **Test.** `13_security` "P4-2 …": 31st upload failed before (`expected 201 to be 429`); passes after, and an hour
  later uploads work again.

### P4-3 — Negative fare by an admin (S3, fixed)

- **Steps.** Trip in progress; Super admin `POST /admin/trips/{id}/adjust { fare: -5000 SEK }` → **200**, fare
  −50 kr, `driverEarnings` −36,43 kr, `commission` −14,62 kr. `complete { fare: -1 }` the same.
- **Root cause.** The admin `Money` schema allows negatives (the contract's `Money` may be negative for deltas); the
  bonus and refund paths refuse ≤ 0, the fare paths did not.
- **Fix.** `notBelowZero` in `src/admin/trips.ts`: a fare below 0 is `400 invalid_request`, reason `invalid_amount`
  (before any approval is requested). A fare of 0 stays possible.
- **Test.** `13_security` "P4-3 …" failed before (`expected 200 to be 400`), passes after; trip version and fare
  unchanged after the refusals.

### P4-4 — Forgot admin password (S2, fixed for the test week; self-service proposed)

- **Today.** The start-up log link appears only while the admin has neither a password nor an open link
  (`prepareTestWeek`). After the owner chose a password there is no way back in on Render's free plan: no shell for
  `npm run admin -- link`, and only a Super admin can call `POST /admin/agents/{id}/setup-link` (the owner is the
  only one). The live admin panel has no Team page that calls it either.
- **Smallest safe recovery (no contract change).** A deploy setting, `ADMIN_PASSWORD_RESET`: any new text makes
  **one** new link for `ADMIN_BOOTSTRAP_EMAIL` at the next start, written to the log exactly like the first link
  (`admin password reset link`). The link is marked with a hash of the value, so a sleeping server that wakes does
  not make more; a different value is a new request. Only people with the Render dashboard can set it — the same
  people who already read the first link. The old password works until the new one is chosen; choosing it ends every
  admin session of that account (unchanged `setupPassword`). Staging and development only, like the bootstrap admin.
  Steps for the owner: `docs/DEPLOY_RENDER.md` "Forgot the admin password". The CLI path stays for a shell or the
  database's external URL.
- **Admin panel.** The live sign-in page has "Forgot your password?" with the instruction, in Swedish, French and
  English (`e2e/live-people.spec.ts` "forgot password …").
- **Not built: e-mail self-service.** "E-mail me a link" needs an e-mail provider; Movera has none (server: SMS
  only, `sms_outbox`). Proposal for when one exists: contract `POST /admin/auth/forgot-password { email }` →
  always `202` (no account enumeration), rate limited per e-mail and address, sends the same 72 h single-use setup
  link to the admin's own e-mail only, audited; the panel's sign-in page then gets the form.
- **Tests.** `test/testWeek.test.ts` "forgot password …": failed before (no link logged), passes after; covers once
  per value, sleep / wake, and a new value.

### P4-5 — Telemetry not served (S4, fixed)

- **Steps.** Rider / driver apps send `POST /api/v1/telemetry/logs|analytics|crashes`; server → `404
  operation_not_enabled` (Phase 3 cross-app run).
- **Fix.** `src/telemetry/routes.ts` per contract §11: no token needed (one is used when sent; a stale one is
  ignored), no `Idempotency-Key`, `202` empty body, at most 16 KB (`400 payload_too_large`), body checked against
  the contract schemas, rate limited per address (120 a minute, `429` + `Retry-After`; per server instance), scrubbed
  again (e-mails, phone numbers, coordinates, bearer tokens / JWTs, and keys like `phone`, `token`, `lat`), stored in
  `telemetry` (migration 0019) and deleted after 30 days by the hourly sweep.
- **Test.** `test/e2e/14_telemetry.test.ts` (5 tests) failed before (404), pass after.

### P4-6 — Riders are not zone-scoped (S4, open)

`riders` has no zone column and the contract gives riders no home zone; `GET /admin/riders` and `POST
/admin/riders/{id}/status` therefore act on every rider for any admin with `riders.read` / `riders.block`. The matrix
skips `:riderId` for the zone check and says why. **Owner question:** should a zone-limited admin see only riders
who rode in their zones?

### P4-7 — Phone numbers in the request log (S3, fixed)

- **Steps.** `GET /admin/riders?q=+46701740608` → the Fastify request log line holds `url:
  "/api/v1/admin/riders?q=%2B46701740608"`.
- **Fix.** `src/app.ts`: the request serializer logs method, path without the query string, and request id.
- **Test.** `test/logs_privacy.test.ts`: with the old serializer the log held the number (test failed), with the fix
  it holds the path only; no Authorization header or token in the log either.

### P4-8 — Google Maps keys in history (S2, owner must rotate)

Found with `git log --all -p` (keys shortened here; the full values are in the commits):

| Key | Repo | Commit (date) | Files | Still at a branch tip |
|---|---|---|---|---|
| `AIzaSyB2…g3eQ` | movera-rider-app | `96df05f1` (2026-09-08) added, `72e4bb7a` removed | `android/app/src/main/AndroidManifest.xml`, `ios/Runner/AppDelegate.swift` | no (only in history; branches `audit-live-rider-runtime-20260925`, `audit/all-paths-inverse`, `audit/deep-booking-lifecycle` contain the commit) |
| `AIzaSyB2…g3eQ` | Movera-driver-app | `e6729267`, `039b3b7d` (2026-09-17) added, `f3c6cb69` removed | same two files | **yes**: `chore/drider-phase0-1-baseline`, `chore/extract-uploaded-project` |
| `AIzaSyBJ…Dml8` | movera-rider-app | `c96550a1` (2026-09-14), `be853f02` (2026-09-27) | `index.html` (a web build) | **yes**: `web-preview-reservation`, `web-live` |

Every other hit was a test placeholder (`postgres://movera:movera@127.0.0.1`, `JWT_SECRET: "test-…"`, a base64 image
matching `AKIA` case-insensitively). **Owner:** rotate both keys in Google Cloud, restrict the new ones (Android
package / iOS bundle id; the web key by HTTP referrer), keep them out of git (`main` of both apps holds no key today), and delete or rewrite the four branches above when no longer needed. A key in a web build is always
visible to the browser, so the referrer restriction is what protects it.

### P4-9 — Rider off-contract calls (S4, fixed in movera-rider-app)

`RideCatalogController` and `RiderPromotionRepository` no longer call `/ride-types` and `/rider/promotions/active`
when `ApiClient.contractWire` is true (staging, production); the demo's in-process mock still serves both. Test:
`test/audit/phase4_off_contract_calls_test.dart` (2 of 3 failed before). `promotion_refresh_failure_test.dart` now
runs on the demo wire, where the lookup still happens; its assertions are unchanged.

## Not done / limits

- `gitleaks` itself was not run here (not installed, download not permitted); CI's `gitleaks-action` scans each PR.
- Flutter dependency advisories not checked (no reachable advisory source). Suggest turning on Dependabot alerts in
  all five repositories.
- The rider app calls more paths that are not in the contract (`/safety/*`, `/account/security`, `/rides/{id}/…`);
  whether they run on the contract wire was not checked in this phase.
- Rate limits are per server instance (in memory for telemetry); fine for one instance in the test week.
