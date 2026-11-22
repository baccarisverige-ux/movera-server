import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_PHONES } from "../../src/auth/testPhones.js";
import { sheddable } from "../../src/http/shed.js";
import { notify } from "../../src/notifications/service.js";
import { adminSession } from "../support/admin.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { call, signIn, testWorld } from "../support/world.js";

/**
 * Contract v0.18.145 (contract.json#loadCut.homeBadges, S4c load cut): GET /driver/home-badges answers the driver
 * Home's four badge reads in one request, each part exactly what its own read answers; the four reads stay.
 */

let database: TestDatabase;
let app: FastifyInstance;
const clock = { now: new Date("2026-11-20T09:00:00Z") };
const H: Record<string, Record<string, string>> = {};

beforeAll(async () => {
  database = await freshDatabase();
  app = await testWorld(database.db, database.url, clock);
  for (const [who, phone, country, cityId] of [["se", 1, "SE", "stockholm_lan"], ["fr", 4, "FR", "paris"]] as const) {
    H[who] = (await signIn(app, TEST_PHONES[phone]!, "driver")).headers;
    const res = await call(app, "POST", "/driver/onboarding", H[who]!, {
      firstName: "Omar", lastName: "Said", dateOfBirth: "1988-04-01", email: `${who}@example.com`, country, cityId, language: "sv", accountType: "driver", termsAccepted: true,
    });
    expect(res.statusCode, res.body).toBe(200);
  }
  // A driver who has not sent his details yet (no country).
  H.none = (await signIn(app, TEST_PHONES[2]!, "driver")).headers;
  H.rider = (await signIn(app, TEST_PHONES[0]!, "rider")).headers;
  const se = (await call(app, "GET", "/driver/profile", H.se!)).json().driverId as string;
  await notify(database.db, { audience: "driver", subjectId: se, kind: "document_approved", title: "Approved", body: "Your document was approved." }, clock.now);
});
afterAll(async () => {
  await app.close();
  await database.drop();
});

const get = async (path: string, who: string) => {
  const res = await call(app, "GET", path, H[who]!);
  expect(res.statusCode, `${path} ${res.body}`).toBe(200);
  return res.json();
};

describe("GET /driver/home-badges (v0.18.145 loadCut.homeBadges)", () => {
  for (const who of ["se", "fr"]) {
    it(`${who}: one read answers what the four badge reads answer`, async () => {
      const badges = await get("/driver/home-badges", who);
      expect(Object.keys(badges).sort()).toEqual(["notifications", "onboardingSettings", "profile", "reminders"]);
      expect(badges.profile).toEqual(await get("/driver/profile", who));
      expect(badges.notifications).toEqual(await get("/notifications?unreadOnly=true", who));
      expect(badges.reminders).toEqual(await get("/driver/reminders", who));
      expect(badges.onboardingSettings).toEqual(await get("/driver/onboarding/settings", who));
      expect(badges.onboardingSettings.country).toBe(who.toUpperCase());
    });
  }

  it("the unread notice shows in the notifications part", async () => {
    const badges = await get("/driver/home-badges", "se");
    expect(badges.notifications.items.map((n: { kind: string }) => n.kind)).toEqual(["document_approved"]);
    expect((await get("/driver/home-badges", "fr")).notifications.items).toEqual([]);
  });

  it("an account with no country yet: onboardingSettings is null (the old read answers 400 country_required)", async () => {
    const badges = await get("/driver/home-badges", "none");
    expect(badges.onboardingSettings).toBeNull();
    expect(badges.profile).toEqual(await get("/driver/profile", "none"));
    expect((await call(app, "GET", "/driver/onboarding/settings", H.none!)).json().reason).toBe("country_required");
  });

  it("riders and signed-out callers are refused as on the four reads", async () => {
    expect((await call(app, "GET", "/driver/home-badges", H.rider!)).json().reason).toBe("wrong_actor");
    expect((await app.inject({ method: "GET", url: "/api/v1/driver/home-badges" })).statusCode).toBe(401);
  });

  it("is never shed: it carries GET /driver/profile, which is never shed", () => {
    expect(sheddable("GET", "/api/v1/driver/home-badges", "/api/v1/driver/home-badges")).toBe(false);
  });

  it("a preview account gets the empty answers of a new account", async () => {
    const owner = await adminSession(app, database.db, "super", { now: clock.now });
    const res = await app.inject({ method: "POST", url: "/api/v1/admin/preview-sessions", headers: { ...owner.headers, "content-type": "application/json", "idempotency-key": "pv-badges-0000000001" }, payload: { role: "driver", zoneId: "Z001" } });
    const headers = { authorization: `Bearer ${res.json().token}` };
    const badges = (await app.inject({ method: "GET", url: "/api/v1/driver/home-badges", headers })).json();
    expect(badges).toMatchObject({ profile: { driverId: "preview:driver:Z001", firstName: "" }, notifications: { items: [], nextCursor: null }, reminders: { items: [], blocksOnline: 0 }, onboardingSettings: null });
  });
});
