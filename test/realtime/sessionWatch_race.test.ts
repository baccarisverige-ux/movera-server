import { afterAll, beforeAll, expect, it } from "vitest";
import { SessionWatch } from "../../src/realtime/sessionWatch.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";

/**
 * B1.15 race (supervisor NO-GO on 9ad3ec4, src/realtime/sessionWatch.ts check()): a stream opened while a check's
 * query runs was not asked about, so that check must not judge it. Before the fix the ids were taken before the query
 * but the streams judged after it, so the new stream (alive session) was closed with ": session ended; sign in again".
 */

let database: TestDatabase;

beforeAll(async () => {
  database = await freshDatabase();
  const future = new Date(Date.now() + 86_400_000);
  for (const id of ["ses_race_1", "ses_race_2"]) {
    await database.db.insertInto("auth_sessions").values({ session_id: id, actor: "rider", subject_id: "rdr_race", expires_at: future } as never).execute();
  }
});
afterAll(async () => {
  await database.drop();
});

it("a stream opened while a session check is running is not closed by that check (its session is alive); the next check judges it", async () => {
  const watch = new SessionWatch(database.db, { everyMs: 60_000, warn: () => undefined });
  const ended: string[] = [];
  const stop1 = watch.add({ sessionId: "ses_race_1", actor: "rider" }, () => ended.push("ses_race_1"));
  const inFlight = watch.check();
  const stop2 = watch.add({ sessionId: "ses_race_2", actor: "rider" }, () => ended.push("ses_race_2"));
  await inFlight;
  expect(ended).toEqual([]);
  // The next check asks about both sessions; both are alive, so nothing ends.
  const before = watch.checks;
  await watch.check();
  expect(watch.checks).toBe(before + 1);
  expect(ended).toEqual([]);
  // And a stream that closes while a check runs is not ended by it either.
  await database.db.updateTable("auth_sessions").set({ revoked_at: new Date() } as never).where("session_id", "=", "ses_race_2").execute();
  const third = watch.check();
  stop2();
  await third;
  expect(ended).toEqual([]);
  stop1();
});
