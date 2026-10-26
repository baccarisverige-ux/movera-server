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
| 26 | Rider late cancel fee | 65 kr for every car type after the free minutes, all of it to the driver. An admin can change the fee per car type and set another driver share (contract and admin panel to add the share setting; until then the server uses 100 %). |
| 27 | Rider PIN | Off in the test week. |
| 28 | Driver ends the ride with the rider on board | The rider pays for what was driven, like an early end, never more than booked; an admin can refund. |
| 29 | Pickup pay on a no-show or late cancel | Not paid; the fee share is the driver's money for it. |
| 30 | Refunds (cash week) | The rider chooses: credit in the Movera wallet at once (used first on the next ride), or money back in 2–3 days. Sweden: Swish or bank account; France and Tunisia: bank account only. An admin sends it by hand and marks it paid in the admin panel. |
| 31 | Who pays a refund | The admin chooses each time: Movera by default (the driver keeps their earnings), or "take from driver", which lowers the driver's earnings by the driver's share. |
| 32 | Reassign after accept | The driver gets nothing by default; the admin can add a driver bonus (Movera pays, within the bonus limit). |
| 33 | Admin cancel after accept | The rider pays nothing (as the admin panel decides); the driver as in 32. |
| 34 | Admin waives an owed fee | The driver keeps the share already credited; Movera carries the loss. |
| 35 | Driver silent with the rider on board (2026-10-26) | No driver position for 30 minutes while the rider is on board (`rider_onboard`, `in_trip`, `approaching_dropoff`): an alert for admins (`driverSilentAlert` on the admin trip). Still none after 3 hours: the server fails the trip (system `fail` → `failed`) with no charge; the rider can book again and the driver is free. An admin is to set the right fare afterwards (not possible yet: adjust, complete and refund all refuse a failed trip). Before pickup nothing happens: the rider cancels and books again. |
| 36 | Going offline after missed offers | 2026-10-26: a driver is put offline after **10** missed or declined Exclusive offers in a row (was 3). Radar offers never count. The number is `DriverAppConfig.offers.autoOffline.missedExclusive` (contract v0.5.6 default 10; the sample settings carry 10); the driver app counts and goes offline. A zone published with 3 keeps it until its driver settings are published again. |
| 11 | Trip GPS paths | Kept 30 days, then deleted. Only each driver's latest position is kept beyond that. |

## Driver sign-up and fleets (round 4, owner decisions of 2026-10-25; contract v0.5.3 §14)

| # | Question | Decision |
|---|---|---|
| R4-1 | Sign-in screens | The driver app signs in like the rider (phone and code), with "Driver" under the logo and no Apple / Google. Then one details screen (white, plain): first and last name, date of birth, e-mail, country, city, language, Driver or Fleet. The app opens with the account on hold. |
| R4-2 | Countries and cities | Sweden (Stockholm län, which includes Södertälje) and France (Paris) are open; Tunisia is shown but cannot be chosen yet. |
| R4-3 | Minimum age | 21. |
| R4-4 | Account types | *Driver*: works for a fleet, paid through it, no company or bank documents of his own. *Fleet*: a company with cars and drivers; its owner may drive too (then he needs his driver documents as well). |
| R4-5 | Sweden documents | Driver: terms, information session, driving licence, profile photo, taxi driver licence (no Transportstyrelsen permit, no F-skatt, no company registration, no bank statement). Fleet: all of today's list (company registration, taxi traffic permit, tax settings, bank statement, plus the owner's driver documents). Car: registration certificate, insurance. |
| R4-6 | France documents | As Uber / Bolt ask there. Driver: VTC card, driving licence, ID, profile photo (and the terms). Fleet: Kbis / SIRENE under 3 months, VTC operators register certificate, RC pro, URSSAF certificate, the manager's ID, the company RIB. Car: carte grise, passenger transport insurance, VTC macaron. The information session is Sweden only; the terms are for everyone. |
| R4-7 | Joining a fleet | The server makes the fleet's code (`MV-` + 5 characters) when an admin approves the fleet; the owner sees it in his app and shares it. A driver joins with the code **and** the owner's full name **and** e-mail as registered; all three must match, one mismatch message, 10 tries per hour. An admin can make a new code. |
| R4-8 | Cars | The fleet owner adds the cars in his app and an admin approves each. A linked driver sees the fleet's approved cars and picks the one he drives; one car has one driver at a time (in use while that driver is online or on a trip). Before he is linked, the app says the fleet's vehicle details are awaited. |
| R4-9 | Money | A fleet driver's earnings are paid to the fleet's bank; the driver sees his own trips and earnings, the owner sees every driver's earnings. |
| R4-10 | Leaving | The owner can remove a driver, the driver can leave (not during a trip), an admin can do both. The driver is back to waiting for a fleet. |
| R4-11 | Documents upload | For real: files go to the server (Europe), sealed at rest (`DOCUMENT_FILES_KEY`), read only by their owner, his fleet owner and admins with `documents.approve` (every admin read is in the audit). Approve / reject in the admin panel; the account leaves on hold when an admin activates it. |
| R4-13 | Sign-in screens, revised | The details screen is step 3 of the sign-in (phone, code, details), with the Movera wordmark and "Driver" like step 1. Apple and Google sign-in are added on step 1 (reversing R4-1): after Apple / Google the phone is still confirmed with a code the first time; later Apple / Google alone signs in. The details step is prefilled with what the provider gave (editable). Until the owner's Apple / Google developer keys exist the buttons say "Coming soon" (server: `503 provider_not_configured`). |
| R4-14 | Joining is an invitation | Two-sided: the driver asks with the code, the owner's name and e-mail → the owner accepts or declines; or the owner invites a phone number → the driver accepts or declines (a number without an account gets the invitation when it signs up). Both sides are told in the app (badge on Home and My fleet, `fleet_invitation` notification) and by one SMS; an invitation lasts 7 days; an admin sees pending ones on the fleet and may accept or cancel; automatic between driver and owner by default. |
| R4-15 | SMS provider | None yet; the owner picks one (46elks for Sweden, or Twilio). Until then messages are kept in `sms_outbox` as skipped and only test numbers can sign in. |
| R4-12 | Demo address search | Left as it is (the owner does not care about the demo); the test week searches through the server and Google, which needs `GOOGLE_MAPS_API_KEY`. |

Implementation notes (server): new drivers stay `pending` until the details are sent (`on_hold` afterwards); drivers made before v0.5.3 by the CLI keep the old rules (own car, no fleet needed). A blocked fleet takes its drivers offline; a trip under way runs to its end. A car that is no longer approved takes its driver offline too.

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

## The ride (step 11)

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

## Admin tools (step 12)

Technical rules:

- Every admin trip change is audited (`GET /admin/audit`); the admin's note stays in the audit, never on the rider's screen.
- Assign and radar group need an active, online driver with a fix in the last 2 minutes and no ride; the automatic search waits while the admin's offers are open. Bonus per trip at most `driver.driverBonus.defaultLimit` (200 kr), never above `hardMax`.
- A paid trip's fare is changed with a refund, not an adjust. A changed fare keeps the lines and adds one `adjustment` line with the difference; the driver keeps the same share of the fare.
- Changes after a trip ended go out as `payment_updated` events (the apps accept those after the end).
- Refunds: at most what the trip was paid, in total. Non-super admins' refunds and adjusts wait for a second admin.
- Wallet: used first on the next ride (from boarding the driver sees `cashToCollect`); the driver's earnings do not change, Movera covers the wallet part.
- A blocked driver goes offline (a ride already going runs to its end) and loses open offers; a blocked rider cannot book.
- The wallet pays exactly what the driver was shown at boarding; money reaching the wallet later stays there for the next ride.
- A fee carried by a ride still going cannot be waived until that ride is over. The fare can be changed only after a driver accepted (before, the offers carry the price).
- The bonus limit counts everything on a trip: the trip bonus and money given to drivers who lost it.
- A refund is at most what the rider paid (cash taken + wallet). A refund that cannot work is refused at once, also for admins whose refunds wait for approval.
- Payout accounts are shown only to finance admins of the trip's zone.
- Later: `GET /admin/refunds` (list), a `pending_approval` refund row while it waits, and rider lists by zone (riders have no home zone yet).

Contract v0.5.4 additions this needs (the server already does them; the contract and the apps follow; v0.5.2 was the rider map's nearby cars, v0.5.3 the driver sign-up and fleets):
`TripProjection.walletApplied` and `cashToCollect`; fare line `adjustment`; `driverBonus` on admin cancel and reassign (money for the driver who lost the ride); `fromDriver` on refunds; `Refund.destination`, `payoutStatus`, `paidAt`, `fromDriver`; `GET /rider/refunds`, `POST /rider/refunds/{refundId}/destination` (wallet / swish / bank, Swish only in Sweden), `GET /admin/refunds/payouts`, `POST /admin/refunds/{refundId}/paid`; `DriverAppConfig.cancelFees.driverSharePct` (decision 26); `PaymentIntent.cashCollected` and `walletApplied` in the admin list.

## Before every test round

No tester starts a round until its features pass this gate:

1. Deep audit of the round's features in all four repos (server, rider, driver, admin): contract agreement, money agreement, bad network / double tap / restart, who may see and change what. Independent reviewers, each finding double-checked.
2. Every high and medium finding fixed; small ones fixed or listed.
3. An automatic full ride against the staging server playing rider, driver and admin together, including cancels and timeouts. Earlier rounds get a lighter re-check.
4. A short report to the owner; testers start on the owner's "go".

## Questions before every part

Before building a part, every decision only the owner can make is asked, one question at a time, each with a recommendation. What the apps or the admin panel already decide is checked first and not asked again. Answers are recorded in this file.
