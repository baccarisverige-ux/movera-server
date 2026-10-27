# Owner device checklist (audit phases 5–7)

What the audit could not check in a container: no iPhone, no Android phone, no Safari, no Google Maps key, no real GPS. Please run these on real phones with the **live** links and the test accounts (code `1234`):

- Rider: https://baccarisverige-ux.github.io/movera-rider-app/live/ — +46 70 174 06 08 (or 09, 10)
- Driver: https://baccarisverige-ux.github.io/Movera-driver-app/live/ — +46 70 174 06 05 (or 06, 07)

Phones: one iPhone (Safari, and the app added to the Home Screen), one Android (Chrome). Charge both to 100 %, turn off Low Power / Battery Saver, screen brightness about half. Wake the server first (open https://movera-server.onrender.com/healthz and wait until it answers).

For each item write: phone and OS version, browser, pass or fail, and what you saw. A screen recording helps most (iPhone: Control Centre → Screen Recording; Android: Quick Settings → Screen record).

## 1. Pinch zoom on the maps (phases 5–6, note N6)

On each of these screens, pinch in and out 10 times, then drag the map, then wait 5 s:
- Rider: Select ride, Finding a driver, the trip map (driver coming, on trip).
- Driver: the trip map (to pickup, on trip).

Pass: the map follows the fingers, does not snap back while a finger is down, the route line keeps its width, the page does not reload (Movera logo) or go back to Home.

## 2. WebGL loss on iOS Safari (phases 5–6)

iPhone only. Book and cancel a ride 10 times in a row without closing the tab (Home → Where to → pick a destination → choose a ride → confirm → Cancel). Then do 2 full trips with the driver phone.

Pass: no blank or flickering map, no white screen, no reload to the Movera logo, no jump back to Home. If it fails, note after which booking and on which screen. (Container measurement: 2 Google maps reused for the whole session, Flutter's WebGL contexts flat at 4, JS heap +0.86 MB a booking; see `movera-rider-app/docs/audit/phase-7.md`.)

## 3. Safari reload (note N3, phase 7)

iPhone, the Home Screen app. On every booking step (Plan your ride, Select ride, Set pickup, Finding, Waiting, On trip, Done): switch to another app for 1 minute, come back. Also lock the phone for 5 minutes on Finding and on the trip.

Pass: the same screen comes back (a short reload is acceptable only if it lands on the same step); the trip is never lost. Note every time the Movera logo shows.

## 4. GPS while driving (phase 6)

Driver phone in a car (someone else drives, or a slow walk for a first check), a real trip with the rider phone:
- Go online, accept the trip, drive to the pickup, start, drive at least 2 km, complete.
- Watch the rider phone at the same time.

Pass: the driver's car moves smoothly on both phones and is never more than about 30 s behind; the driver keeps getting offers after 5 minutes online (the server needs a position at least every 2 minutes; the container lab could not produce a GPS fix, so this is unverified); the route redraws after a wrong turn; arrive/complete work at the real address (100 m check).

## 5. Battery and heat (phase 7)

Each test 30 minutes, screen on, note the battery % at start and end and whether the phone gets warm:
- Driver: Home **offline**, untouched (the Radar orb pulses all the time: in the container that cost 2,025 frames and 11 s of main-thread time a minute, finding P7-D1).
- Driver: Home online, no offers.
- Driver: a trip with navigation.
- Rider: Home, untouched.
- Rider: Finding a driver / waiting for the driver.

Optional, more exact: iPhone Settings → Battery shows the use per app for the last 24 h; Android Settings → Battery → Battery usage.

## 6. Frame rate (phase 7)

On each phone, drag the Select ride sheet up and down 10 times, and scroll the driver's Radar list.

Pass: no visible stutter. Optional measurement on Android: Settings → Developer options → Profile HWUI rendering → "On screen as bars" (green line = 16 ms); note how often bars cross it. On iPhone, record the screen and look for jumps.

## 7. Afterwards

Send the notes (and recordings) to the audit; each failure becomes a finding with steps to reproduce.
