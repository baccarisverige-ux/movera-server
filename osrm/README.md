# Movera's own route server (OSRM, Sweden) — ready, not switched on

Nothing here changes the running test server or Render. The main server image does not use this folder
(the root `Dockerfile` copies only `package*.json`, `tsconfig*.json`, `src/`, `contracts/`, `migrations/`), and
`render.yaml` is unchanged (it still uses the public demo at `OSRM_URL`).

## Design
The heavy work (download the Geofabrik Sweden map ~0.8 GB, `osrm-extract`, `osrm-partition`, `osrm-customize`,
car profile, MLD) runs on a **GitHub Actions runner**, not on Render's build machine. GitHub's standard runner for a
public repository: 4 CPU, 16 GB memory, 14 GB disk (GitHub docs, "GitHub-hosted runners"). The workflow frees disk
first, checks the map's md5, builds, starts the image, asks 20 Stockholm / Göteborg / Malmö routes, and only then
publishes `ghcr.io/baccarisverige-ux/movera-osrm:sweden-<date>` and `:sweden-latest`.
Render then only **pulls a ready image**: no build, start in about a minute.

Estimates (to be confirmed by the first run; the workflow prints peak memory, image size and running memory):
- map files ≈ 2–3 GB, image ≈ 1.2–1.8 GB compressed;
- running memory ≈ 1.5–2.5 GB → Render plan **pro (4 GB)**; standard (2 GB) is too tight.

## Owner steps (when the new server is created — ask Claude first)
1. GitHub > movera-server > Actions > "OSRM Sweden image" > **Run workflow** (defaults). ~30–60 min. Read the summary:
   20 routes must say `RESULT: PASS`.
2. GitHub > your profile > Packages > `movera-osrm`: either set visibility **Public** (no secrets needed; the map is
   public data), or keep it private and make a token for Render (names only: a GitHub *personal access token
   (classic)* with scope `read:packages`; in Render: *Settings > Registry Credentials*, registry "GitHub",
   username = your GitHub name, token = that token).
3. Render > New > **Private Service** > "Existing image" > `ghcr.io/baccarisverige-ux/movera-osrm:sweden-latest`
   (+ the registry credential if private), region **Frankfurt** (same as the server), plan **pro**, port 5000.
4. In the PRODUCTION server service set `OSRM_URL = http://<internal address>:5000` (Render shows it).
   Way back: remove `OSRM_URL`.
5. Fresh map: run the workflow again, then Render > the service > Manual Deploy. (Monthly schedule is in the
   workflow, commented out.)

## Local use
`./build.sh` (needs ~16 GB memory for Sweden) or put a small `.osm.pbf` at `data/region.osm.pbf` to test.
`node test/compare-routes.mjs --own http://127.0.0.1:5000 --pairs test/sweden-pairs.json` compares with the demo
server (add `--no-demo` to skip it). A point outside the map is not an error in OSRM; the test catches it
(point moved > 300 m).
