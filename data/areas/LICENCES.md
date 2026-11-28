# Area data (v0.18.172 preferred areas)

Built offline by `tools/areas/build_areas.py` (2026-11-28); the server upserts these rows at boot (`src/areas/seed.ts`).
No OpenStreetMap data (owner 2026-11-25).

| File | Source | Licence | Credit | Downloaded | Year |
|---|---|---|---|---|---|
| se.geojson | SCB, Regionala statistikområden (RegSO) 2025, WFS `stat:RegSO_2025` at geodata.scb.se (Stockholms län, lanskod 01). The 26 kommuner are the union of their RegSO; the 11 stadsdelsområden of Stockholms stad are the union of the RegSO tagged to each district name (derived, approximate). | CC0 1.0 | "© SCB" (not required by CC0; shown in the driver app) | 2026-11-28 | 2025 |
| fr.geojson | IGN, ADMIN EXPRESS COG CARTO (LATEST), WFS `ADMINEXPRESS-COG-CARTO.LATEST:commune / arrondissement_municipal / departement` at data.geopf.fr (Île-de-France, region 11). | Licence Ouverte 2.0 (Etalab) | "© IGN – ADMIN EXPRESS" | 2026-11-28 | 2025 |

Rows: SE 37 (26 kommuner + 11 stadsdelsområden); FR 1294 (1265 communes other than Paris + 20 arrondissements + Paris + 8 départements).
The plan's estimates were SE 36 / FR 1296; `manifest.json` holds the real counts of these sources and the seed checks them.
Outlines simplified to about 45 m (`shapely.coverage_simplify`, shared borders kept), points rounded to 5 decimals.
