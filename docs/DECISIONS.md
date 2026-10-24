# Owner decisions (2026-10-23)

What the server does for the test week, as the owner chose it. Change a line here when a decision changes.

| # | Topic | Decision |
|---|---|---|
| 1 | Test sign-in | Test numbers +46 70 174 06 05 … 06 10 (reserved fiction range, no real subscriber). Code `1234`, staging only. |
| 2 | Other numbers | Refused (`403`, reason `sign_in_restricted`). No SMS provider in the test week. |
| 3 | Hosting | Oxahost virtual server in France, 8 GB memory. PostgreSQL in the same container stack, nightly backup. Revisit a managed database before public launch. |
| 4 | Maps | Address search: Google Places/Geocoding through the server. Routes, distance, arrival times: our own OSRM (Sweden) on the same server. Driver navigation uses it too. |
| 5 | Commission | 20 %, with the admin panel's Stockholm prices, sent to every app as one price list. |
| 6 | Dispatch | The server follows the admin panel's dispatch rules per zone: mode (Auto, Radar, Exclusive, time rules), drivers and seconds per mode, growing search area, what happens when nobody accepts, best-driver score, rider-waiting steps. Later: extras, airport queue, events, batching, fairness, safety filters. |
| 7 | Cancel and no-show fees | The admin panel's fee rules. Cash only: the fee puts the rider's account in minus, paid on their next ride. The driver's share shows in their earnings at once and is part of Movera's regular payout. |
| 8 | Rider ends the ride early | Base + km driven × price per km + minutes on board × price per minute, never more than the booked price, rounded to the price step. |
| 9 | Admin sign-in | Test week: e-mail + password only (the owner chose no authenticator for now). One Super admin, the owner's e-mail (set on the server, not in git). The owner chooses the password at first sign-in through a one-time setup link (at least 10 characters, argon2id); failed attempts are slowed and locked. The authenticator code is added before the public launch; the admin panel hides its code field until then. More admins are added from the admin panel. |
| 10 | Extras in the test week | Main ride only: book, find driver, pickup, drive, cash, rating. Safety, promotions, raise price and pickup move stay hidden; the rider-waiting steps "raise price" and "upgrade" are skipped. |
| 12 | Apple / Google sign-in | Off in the test week (buttons hidden); added before the public launch. |
| 13 | Test drivers | Created on the server already approved, with the real first name, car model, colour, plate and car type the owner sends. Each test number works in both apps. |
| 14 | Second-admin approval | A Super admin never needs a second admin: their changes go live at once and are written in the history. Big changes by other admins still wait for another admin's approval. |
| 15 | Zones open in the test week | Norrmalm (Z001), Södermalm (Z002), Östermalm (Z003), Kungsholmen (Z004), Vasastan (Z005) and Södertälje (Z009). Rides can end anywhere; a pickup elsewhere is "not available here yet". |
| 16 | Premium commission | Premium keeps the admin panel's 22 % commission and 12 % app fee; every other car type 20 % and 10 %. |
| 17 | Waiting money | 100 % to the driver; no commission on waiting. |
| 18 | Money split | The admin panel's way in every app: the rider pays ride + extras + app fee (+ pickup fee). Movera keeps the app fee, the pickup fee and the commission on the ride and extras except waiting; the driver gets the rest and all waiting money. |
| 19 | Rider ends early (details) | The same surge as booked, the minimum price, the app fee and the pickup fee apply; never more than the booked price; rounded to the price step. |
| 20 | Extra stops | Pricing's amounts per car type (stop fee, waiting per minute at a stop) with the first 3 minutes at each stop free. The duplicate money fields in Dispatch › Stops go away. |
| 21 | Surge | Automatic surge off in the test week; an admin can start one by hand. At most ×3. |
| 22 | Search gap | When the admin steps are used up before the search ends, offers keep going: Radar again at the widest area every Radar period, Exclusive to drivers not yet asked (newly free drivers count). |
| 23 | A driver who declined | May get the same ride again later (on a later Radar round), like a driver who missed it. |
| 24 | "Keep waiting?" | Keep waiting = the search gets the step's extra minutes (3) and "busy" moves later; Stop = free cancel; no answer = the search continues. |
| 25 | Rider cancel fee: was the driver coming? | After the free 2 minutes the rider pays only if the driver came closer to the pickup by at least half of what a normal car covers since accepting (400 m a minute, so 200 m per minute). A driver at the pickup counts; no driver position means no fee. Replaces the admin's flat 25 %, which fails for far pickups. |
| 11 | Trip GPS paths | Kept 30 days, then deleted. Only each driver's latest position is kept beyond that. |

## Requested features (later round: driver sign-up)

- **Driver sign-up with fleets.** A new driver creates their own account and chooses: *fleet owner account*, or *driver*. A driver can later use a menu option to ask to join a fleet (fleet name, phone, e-mail); an admin approves it after checking with the fleet owner. The admin panel already has fleet owners (codes like FO-SE-01); the driver app has neither the choice nor the join request yet. Needs a contract addition, server, driver app and admin approval screen.

Technical rules decided without the owner (they match what the apps already do):

- A live trip is accepted only from an open offer (`offered`); `accepted` straight from `requested` is for scheduled trips only (contract v0.5.1).
- `acceptedAt` is cleared when a trip goes back to searching.
- One driver declining in a Radar group leaves the trip `offered` while other offers are open.
- `ratingStatus` follows the rider's rating; driver ratings are stored separately.
- Approvals and Idempotency-Keys are kept 24 hours.
- A quote is valid 5 minutes. Until our OSRM runs, the server estimates a route as straight line × 1.25 at 24 km/h (the admin panel's dispatch formula) and stores which one it used.
- Settings: a zone with no draft yet takes its first save with `expectedVersion` 1; on publish the server stamps the next live `version` and `publishedAt` into the document.
- A trip is booked only from the rider's own unused, unexpired quote with the same car type, places and kind (else `quote_used`, `quote_expired`, `quote_mismatch`); payment methods come from the `PAYMENT_METHODS` setting (test week: `cash`), and `GET /payment-methods` lists cash as the one default.
- Dispatch: a search that starts while its zone is paused begins its steps when the zone resumes; a zone with no published dispatch rules sends no automatic offers and its trips expire after 10 minutes (an admin can still assign). Offers go only to active, online drivers with a fix in the last 120 s, the trip's car type and zone. A driver who still has a rider gets no offer in the test week (next trips while driving are a later round, decision 10). Going offline or taking a trip withdraws the driver's other open offers.
- A pickup outside the open zones is `403 forbidden`, reason `service_not_available`; an open zone without published prices is `503`, reason `pricing_not_published`.

## The ride (step 11): choices waiting for the owner's OK

Built with these, each easy to change; the owner confirms or changes them before the test round:

- **Driver's share of a rider cancel fee**: 80 %, the same as the no-show share (`waiting.driverSharePct`). The admin panel has no separate setting.
- **Rider PIN at boarding**: off in the test week (the rider config has `features.pin` false).
- **Driver ends the trip with the rider on board**: the rider pays for what was driven, like an early end; an admin can refund.
- **Pickup pay on a no-show or a paid rider cancel**: not paid now (the driver gets the 80 % fee share instead).

Technical rules for the ride (no owner decision needed):

- The waiting clock starts at `arrive`; the seconds after the free wait are charged when the rider boards, and the fare is priced again then (waiting is 100 % the driver's). A no-show is allowed from `waiting.noShowAt`.
- Waiting money and the no-show fee come from the pricing document (the admin's Pricing page), the cancel fee rules from the published rider settings; with no rider settings published, a cancel after accept is free.
- `arrive` is accepted only within 300 m of the pickup (the driver's latest fix); a reservation's waiting clock starts at the booked time, not at an early arrival.
- The driver's free-text cancel note is kept for Movera and never shown to the rider.
- A short cash count pays the ride first; owed fees are cleared only by cash beyond the ride.
- "Almost there" (`near_dropoff`) when the driver's fix is within 500 m of the drop-off during the ride.
- A no-show or cancel fee nobody collected is owed (Rider.outstanding) and rides on the next quote; the driver's share is credited at once. When a cash trip that carries it completes, the oldest owed fees up to the carried amount are paid.
- A driver who cancels before boarding is not offered that trip again; every driver cancel is recorded for the cancel rate.
- Cash: `complete` marks the payment `captured`; `cashCollected` is stored as the driver reports it (the admin sees any difference). Tips are refused (`tips_not_available`) until a later round.
- A skipped rating answers `204` (the contract's `Rating` needs stars).

## Before every test round

No tester starts a round until its features pass this gate:

1. Deep audit of the round's features in all four repos (server, rider, driver, admin): contract agreement, money agreement, bad network / double tap / restart, who may see and change what. Independent reviewers, each finding double-checked.
2. Every high and medium finding fixed; small ones fixed or listed.
3. An automatic full ride against the staging server playing rider, driver and admin together, including cancels and timeouts. Earlier rounds get a lighter re-check.
4. A short report to the owner; testers start on the owner's "go".

## Questions before every part

Before building a part, every decision only the owner can make is asked, one question at a time, each with a recommendation. What the apps or the admin panel already decide is checked first and not asked again. Answers are recorded in this file.
