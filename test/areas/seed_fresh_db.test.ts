import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AREAS_DIR, loadAreaData, seedAreas } from "../../src/areas/seed.js";
import { polygonProblem } from "../../src/zones/geometry.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";

/**
 * v0.18.172 (contract.json#preferredAreas.seed; plan §2.2 seed_fresh_db + seed_licence): a fresh database after migrate()
 * gets exactly the manifest's rows per country; a second run writes nothing; an admin's active=false and name override
 * survive a re-seed; a wrong checksum or row count throws. Every row has source + licence, no OSM, every ring valid.
 */
let database: TestDatabase;
const manifest = JSON.parse(readFileSync(new URL("manifest.json", AREAS_DIR), "utf8")) as { rows: Record<string, number> };
beforeAll(async () => {
  database = await freshDatabase();
});
afterAll(async () => {
  await database.drop();
});
const counts = async () => Object.fromEntries((await database.db.selectFrom("areas").select(["country", (eb) => eb.fn.countAll<string>().as("n")]).groupBy("country").execute()).map((r) => [r.country, Number(r.n)]));

describe("areas boot seed", () => {
  it("the manifest's counts are the real ones of the sources (SE 37, FR 1294)", () => {
    expect(manifest.rows).toEqual({ SE: 37, FR: 1294 });
  });
  it("fresh database: migrate then seed gives the manifest's rows per country", async () => {
    const result = await seedAreas(database.db);
    expect(result.skipped).toBe(false);
    expect(await counts()).toEqual(manifest.rows);
  });
  it("a second run is skipped and writes nothing; admin switches survive a forced re-seed", async () => {
    await database.db.updateTable("areas").set({ active: false, name_override: "Söder" }).where("area_id", "=", "SE-SDO-SODERMALM").execute();
    const stamp = (await database.db.selectFrom("areas").select("updated_at").where("area_id", "=", "SE-K-0181").executeTakeFirstOrThrow()).updated_at;
    expect((await seedAreas(database.db)).skipped).toBe(true);
    expect((await database.db.selectFrom("areas").select("updated_at").where("area_id", "=", "SE-K-0181").executeTakeFirstOrThrow()).updated_at).toEqual(stamp);
    // A new data set (forget the run) upserts again: the admin's active and name_override are never written by it.
    await database.db.deleteFrom("area_seed_runs").execute();
    expect((await seedAreas(database.db)).skipped).toBe(false);
    expect(await database.db.selectFrom("areas").select(["active", "name_override", "name"]).where("area_id", "=", "SE-SDO-SODERMALM").executeTakeFirstOrThrow()).toEqual({ active: false, name_override: "Söder", name: "Södermalm" });
    expect(await counts()).toEqual(manifest.rows);
  });
  it("a wrong file checksum or row count throws (the server would not start)", () => {
    const dir = mkdtempSync(join(tmpdir(), "areas-"));
    for (const f of ["manifest.json", "se.geojson", "fr.geojson"]) copyFileSync(new URL(f, AREAS_DIR), join(dir, f));
    const url = pathToFileURL(dir + "/");
    expect(() => loadAreaData(url)).not.toThrow();
    writeFileSync(join(dir, "se.geojson"), readFileSync(join(dir, "se.geojson"), "utf8").replace("Södermalm", "Sodermalm"));
    expect(() => loadAreaData(url)).toThrow(/checksum/);
    copyFileSync(new URL("se.geojson", AREAS_DIR), join(dir, "se.geojson"));
    const m = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    m.rows.SE = 36;
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(m));
    expect(() => loadAreaData(url)).toThrow(/SE has 37 rows, manifest.json says 36/);
  });
  it("every row has source + licence, no OSM, and every ring passes polygonProblem", () => {
    const { features } = loadAreaData();
    for (const f of features) {
      expect(f.properties.source, f.properties.areaId).toBeTruthy();
      expect(f.properties.licence, f.properties.areaId).toMatch(/^(CC0|Licence Ouverte 2\.0)$/);
      expect(`${f.properties.source} ${f.properties.licence}`).not.toMatch(/osm|openstreetmap/i);
      for (const polygon of f.polygons) for (const ring of polygon) expect(polygonProblem(ring), f.properties.areaId).toBeNull();
    }
  }, 120_000);
});
