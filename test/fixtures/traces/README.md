# Recorded-style GPS traces (step 72, T13)

Used by `test/e2e/44_gps_traces.test.ts` (one suite per file). Regenerate with `node test/fixtures/traces/generate.mjs`
(deterministic: seeded PRNG, same bytes every run).

**No real person's data.** Each trace is generated, not recorded from a phone:

1. **Road** — an OSRM-like polyline typed by hand from public map coordinates of real streets (vertices every few
   hundred metres; straight segments between them, as OSRM geometry is):
   - `stockholm_sergels_medborgar` (Z001): Sergels torg → Centralbron → Slussen → Söderledstunneln → Ringvägen →
     Götgatan → Medborgarplatsen, ~3.5 km.
   - `paris_chatelet_eiffel` (FR-PC): Châtelet → voie Georges-Pompidou → tunnel des Tuileries → Concorde → Cours la
     Reine → Alma → Quai Branly → Tour Eiffel, ~4.3 km.
   - `tunis_bourguiba_carthage` (TN-TC, owner TN-9): Avenue Habib Bourguiba → Place du 14 Janvier → Avenue Mohamed V
     (trémie) → Charguia → Aéroport Tunis-Carthage, ~8.2 km.
2. **Car** — moves along the polyline at 6–14 m/s, a fix every 5 s, red lights/jams of 30–60 s (one forced 60 s stop).
3. **Defects** (named in the global-plan audits, V35.24): parked driver drifting 10–35 m at the pickup and drop-off;
   Gaussian jitter (5 m, 12 m when stopped); a 30–40 m urban-canyon stretch whose accuracy still says 35–45 m; a 45 s
   and a 90 s signal gap; no fixes inside the tunnel; one confident fix 450 m behind the car (backwards jump); four
   fixes with accuracy 120–300 m and an offset to match; duplicate timestamps (one identical, one same time other
   place); one batch shuffled; one batch delivered after the next one.

File format: `fixes[]` = `{ t (s from trace start), lat, lng, accuracy, speedMps?, heading, truthM (true metres along
the road), defect? }`; `batches[]` = `{ phase: waiting|on_board, sendT, fixes: [index] }` in the order the app sends
them; `roadMeters`, `road`, `tunnel`, `boardT`, `arriveT`, `defects`.
