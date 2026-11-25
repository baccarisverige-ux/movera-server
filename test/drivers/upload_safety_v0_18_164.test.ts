import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_PHONES } from "../../src/auth/testPhones.js";
import { documentKeyFrom, openFile } from "../../src/documents/files.js";
import { seedTestAccounts } from "../../src/drivers/seedTest.js";
import { newId } from "../../src/ids.js";
import { adminSession } from "../support/admin.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { call, signIn, testWorld } from "../support/world.js";

/** Contract v0.18.164 documents.reviewNeedsFile (owner 2026-11-25 "Yes, fix all 3", upload safety). */
let database: TestDatabase;
let app: FastifyInstance;
const clock = { now: new Date("2026-11-25T09:00:00Z") };
let sup: { headers: Record<string, string> };
let driverId = "";

beforeAll(async () => {
  database = await freshDatabase();
  app = await testWorld(database.db, database.url, clock);
  sup = await adminSession(app, database.db, "super", { now: clock.now });
  const h = (await signIn(app, TEST_PHONES[0]!, "driver")).headers;
  const res = await call(app, "POST", "/driver/onboarding", h, { firstName: "Sarah", lastName: "Benali", dateOfBirth: "1988-04-01", email: "sarah@example.fr", country: "FR", cityId: "paris", language: "fr", accountType: "driver", termsAccepted: true });
  expect(res.statusCode, res.body).toBe(200);
  driverId = res.json().driverId;
});
afterAll(async () => {
  await app.close();
  await database.drop();
});

async function fileless(type: string) {
  const documentId = newId("doc", clock.now.getTime());
  await database.db.insertInto("documents").values({ document_id: documentId, driver_id: driverId, owner_kind: "driver", owner_id: driverId, type, status: "in_review", created_at: clock.now, updated_at: clock.now }).execute();
  return documentId;
}

describe("v0.18.164 no approval without a file", () => {
  it("approving a file document with no file is 400 no_file; rejecting still works", async () => {
    const id = await fileless("profile_photo");
    const approve = await call(app, "POST", `/admin/documents/${id}/review`, sup.headers, { decision: "approved" });
    expect(approve.statusCode, approve.body).toBe(400);
    expect(approve.body).toContain("no_file");
    const reject = await call(app, "POST", `/admin/documents/${id}/review`, sup.headers, { decision: "rejected", note: "Pas de fichier" });
    expect(reject.statusCode, reject.body).toBe(200);
  });
  it("an admin_check type (no file by design) is still approved", async () => {
    const id = await fileless("info_session");
    const approve = await call(app, "POST", `/admin/documents/${id}/review`, sup.headers, { decision: "approved" });
    expect(approve.statusCode, approve.body).toBe(200);
  });
});

describe("v0.18.164 seeded test documents have a placeholder file", () => {
  it("every seeded file document has a stored file that opens", async () => {
    const key = documentKeyFrom({ MOVERA_ENV: "development" }, "seed-test-secret".padEnd(48, "s"));
    await database.db.transaction().execute((trx) => seedTestAccounts(trx, undefined, clock.now, key));
    const docs = await database.db
      .selectFrom("documents")
      .leftJoin("document_files", "document_files.document_id", "documents.document_id")
      .select(["documents.type", "documents.file_name", "document_files.key_id", "document_files.iv", "document_files.tag", "document_files.ciphertext"])
      .where("documents.reviewed_by", "=", "seed")
      .execute();
    const files = docs.filter((d) => !["terms", "info_session"].includes(d.type));
    expect(files.length).toBeGreaterThan(0);
    for (const d of files) {
      expect(d.file_name, d.type).toBe("placeholder.png");
      const bytes = openFile(key, { key_id: d.key_id!, iv: d.iv!, tag: d.tag!, ciphertext: d.ciphertext! });
      expect(bytes.subarray(1, 4).toString()).toBe("PNG");
    }
  });
});
