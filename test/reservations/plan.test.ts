import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CONTRACTS_DIR } from "../../src/contract/contract.js";
import { takeBackDecision } from "../../src/reservations/takeBack.js";
import { chargedAtBooking, driverTimes, freeByTime, planOf, RESERVATION_DEFAULTS, reservationSettings, windowError } from "../../src/reservations/plan.js";

/** v0.18.17 Book later: every case of contracts/fixtures/book_later.json (owner 2026-11-03 Q1–Q6). */
type PlanCase = { id: string; bookedAt: string; scheduledAt: string; settings: Record<string, unknown>; expect: Record<string, string | null> };
const fx = JSON.parse(readFileSync(`${CONTRACTS_DIR}/fixtures/book_later.json`, "utf8")) as {
  plan: PlanCase[];
  riderCancel: { id: string; minutesBefore: number; freeChangeBeforeMin: number; expect: string }[];
  driverTimes: { id: string; acceptedAt: string; scheduledAt: string; onlineBeforeMin: number; reminderMin: number[]; offlineBackupAfterMin: number; expect: { reminders: string[]; goOnlineAt: string; offlineCheckAt: string } }[];
};
const iso = (d: Date | null) => (d === null ? null : d.toISOString().replace(".000Z", "Z"));

describe("book later plan (fixtures/book_later.json)", () => {
  for (const c of fx.plan) {
    it(c.id, () => {
      const s = reservationSettings({ ...RESERVATION_DEFAULTS, ...c.settings });
      const booked = new Date(c.bookedAt);
      const at = new Date(c.scheduledAt);
      const error = windowError(booked, at, s);
      if ("error" in c.expect) return expect(error).toBe(c.expect["error"]);
      expect(error).toBeNull();
      const p = planOf(booked, at, s);
      expect({ mode: p.mode, dispatchAt: iso(p.dispatchAt), popupAt: iso(p.popupAt), openAllAt: iso(p.openAllAt), noDriverAt: iso(p.noDriverAt), riderReminderAt: iso(p.riderReminderAt), freeChangeUntil: iso(p.freeChangeUntil) }).toEqual(c.expect);
    });
  }
  for (const c of fx.riderCancel) {
    it(`rider cancel ${c.id}`, () => {
      const at = new Date("2026-11-05T08:00:00Z");
      expect(freeByTime(new Date(at.getTime() - c.minutesBefore * 60_000), at, { freeChangeBeforeMin: c.freeChangeBeforeMin }) ? "free" : "reservation_fee_rule").toBe(c.expect);
    });
  }
  for (const c of fx.driverTimes) {
    it(`driver ${c.id}`, () => {
      const t = driverTimes(new Date(c.acceptedAt), new Date(c.scheduledAt), { onlineBeforeMin: c.onlineBeforeMin, spareMin: 15, reminderMin: c.reminderMin }, c.offlineBackupAfterMin);
      expect({ reminders: t.reminders.map(iso), goOnlineAt: iso(t.goOnlineAt), offlineCheckAt: iso(t.offlineCheckAt) }).toEqual(c.expect);
    });
  }
  it("owner defaults: 15 min to 90 days, 30 min soon, 10 min alert, rider 1 h, change 1 h, driver online 60 min, reminder 2 h", () => {
    const s = reservationSettings(undefined);
    expect([s.minAheadMin, s.maxAheadDays, s.soonBeforeMin, s.noDriverAlertMin, s.riderReminderMin, s.freeChangeBeforeMin, s.rideTypes.normal.onlineBeforeMin, s.rideTypes.normal.reminderMin[0]]).toEqual([15, 90, 30, 10, 60, 60, 60, 120]);
    expect(reservationSettings({ minAheadMin: -3, listTo: "nobody", rideTypes: { normal: { onlineBeforeMin: 30 } } })).toMatchObject({ minAheadMin: 15, listTo: "all", rideTypes: { normal: { onlineBeforeMin: 30, reminderMin: [120] } } });
  });
  it("card on a booked ride is charged at booking (owner Q4); cash and live rides are not", () => {
    expect([chargedAtBooking("scheduled", "card"), chargedAtBooking("scheduled", "apple_pay"), chargedAtBooking("scheduled", "cash"), chargedAtBooking("live", "card")]).toEqual([true, true, false, false]);
  });
});

describe("job 4 take-back (contract.json#bookedTakeBack, owner Q2 / Q-B / fix-plan Q2)", () => {
  it("zone settings: defaults 5 / 10 / 15, admin values in range kept, bad ones fall back", () => {
    expect(reservationSettings(undefined)).toMatchObject({ takeBackLateMin: 5, takeBackKeepIfDriveMin: 10, takeBackUntilMinBeforePickup: 15 });
    expect(reservationSettings({ takeBackLateMin: 8, takeBackKeepIfDriveMin: 0, takeBackUntilMinBeforePickup: 30 })).toMatchObject({ takeBackLateMin: 8, takeBackKeepIfDriveMin: 0, takeBackUntilMinBeforePickup: 30 });
    expect(reservationSettings({ takeBackLateMin: 0, takeBackKeepIfDriveMin: -1, takeBackUntilMinBeforePickup: 999 })).toMatchObject({ takeBackLateMin: 5, takeBackKeepIfDriveMin: 10, takeBackUntilMinBeforePickup: 15 });
  });
  it("taken back only when >5 min late AND >10 min drive AND ≥15 min before pickup", () => {
    const s = reservationSettings(undefined);
    const at = new Date("2026-11-05T08:00:00Z");
    const before = (min: number) => new Date(at.getTime() - min * 60_000);
    // 20 min before, 26 min drive = 6 min late.
    expect(takeBackDecision(before(20), at, 26 * 60, s)).toEqual({ take: true, lateMin: 6 });
    // Exactly 5 min late: kept (more than 5).
    expect(takeBackDecision(before(20), at, 25 * 60, s).take).toBe(false);
    // 10 min before, 16 min drive = 6 min late: no time left to find another driver.
    expect(takeBackDecision(before(10), at, 16 * 60, s).take).toBe(false);
    // Exactly 15 min before, 21 min drive: still in time to take it back.
    expect(takeBackDecision(before(15), at, 21 * 60, s).take).toBe(true);
    // Close to the pickup (8 min drive), late 6 min (until-time 0): kept.
    expect(takeBackDecision(before(2), at, 8 * 60, { ...s, takeBackUntilMinBeforePickup: 0 }).take).toBe(false);
    // No position: no drive known, never taken back.
    expect(takeBackDecision(before(20), at, null, s).take).toBe(false);
  });
});
