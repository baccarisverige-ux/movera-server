import { describe, expect, it } from "vitest";
import { freshDatabase } from "../support/db.js";
import { RUN_DB_PREFIX, TEMPLATE_DB } from "../support/globalSetup.js";

describe("per-run test database names", () => {
  it("are prefixed by a tag of this run's template, so teardown drops only this run's databases", async () => {
    expect(RUN_DB_PREFIX).toMatch(/^movera_t_[0-9a-f]{8}_$/);
    expect(TEMPLATE_DB.length).toBeGreaterThan(0);
    const database = await freshDatabase({ migrated: false });
    try {
      expect(database.name.startsWith(RUN_DB_PREFIX)).toBe(true);
      expect(database.name.length).toBeLessThanOrEqual(63);
    } finally {
      await database.drop();
    }
  });
});
