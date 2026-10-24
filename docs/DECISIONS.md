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
| 9 | Admin sign-in | E-mail, password (argon2id) and a 6-digit authenticator code, the screen the admin panel already has. Accounts are created from the command line. |
| 10 | Extras in the test week | Main ride only: book, find driver, pickup, drive, cash, rating. Safety, promotions, raise price and pickup move stay hidden; the rider-waiting steps "raise price" and "upgrade" are skipped. |
| 11 | Trip GPS paths | Kept 30 days, then deleted. Only each driver's latest position is kept beyond that. |

Technical rules decided without the owner (they match what the apps already do):

- A live trip can be accepted only while `searching` or `offered`; `accepted` from `requested` is for scheduled trips.
- `acceptedAt` is cleared when a trip goes back to searching.
- One driver declining in a Radar group leaves the trip `offered` while other offers are open.
- `ratingStatus` follows the rider's rating; driver ratings are stored separately.
- Approvals and Idempotency-Keys are kept 24 hours.

## Before every test round

No tester starts a round until its features pass this gate:

1. Deep audit of the round's features in all four repos (server, rider, driver, admin): contract agreement, money agreement, bad network / double tap / restart, who may see and change what. Independent reviewers, each finding double-checked.
2. Every high and medium finding fixed; small ones fixed or listed.
3. An automatic full ride against the staging server playing rider, driver and admin together, including cancels and timeouts. Earlier rounds get a lighter re-check.
4. A short report to the owner; testers start on the owner's "go".

## Questions before every part

Before building a part, every decision only the owner can make is asked, one question at a time, each with a recommendation. What the apps or the admin panel already decide is checked first and not asked again. Answers are recorded in this file.
