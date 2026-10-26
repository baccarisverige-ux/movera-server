import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_PHONES } from "../../src/auth/testPhones.js";
import { adminSession } from "../support/admin.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { call, signIn, testWorld } from "../support/world.js";

/**
 * contract v0.5.3 §14, contract.json#driverOnboarding.fleetInvitations: joining a fleet is two-sided. The owner
 * invites a number (owner_invite) or the driver asks with the code (driver_request); the other side accepts or
 * declines; both are told in the app (GET /notifications) and by one SMS (kept in sms_outbox while no provider).
 */

let database: TestDatabase;
let app: FastifyInstance;
const clock = { now: new Date("2026-10-26T09:00:00Z") };
let owner: Record<string, string>;
let anna: Record<string, string>;
let bo: Record<string, string>;
let admin: { headers: Record<string, string>; adminId: string };
let fleetId: string;
let fleetCode: string;
let annaId: string;
let boId: string;

const details = (extra: Record<string, unknown> = {}) => ({
  firstName: "Fredrik",
  lastName: "Åkesson",
  dateOfBirth: "1985-03-12",
  email: "fredrik@example.se",
  country: "SE",
  cityId: "stockholm_lan",
  language: "sv",
  accountType: "fleet",
  termsAccepted: true,
  company: { name: "Åkessons Taxi AB", orgNumber: "556677-8899", address: "Storgatan 1, Södertälje" },
  ...extra,
});
const me = async (headers: Record<string, string>) => (await call(app, "GET", "/driver/profile", headers)).json();
const notices = async (headers: Record<string, string>, unreadOnly = false) => (await call(app, "GET", `/notifications${unreadOnly ? "?unreadOnly=true" : ""}`, headers)).json();
// The test clock stands still, so notices of one command share a timestamp: look them up by title, not position.
const notice = async (headers: Record<string, string>, title: string) => (await notices(headers, true)).items.find((n: { title: string }) => n.title === title);
const outbox = () => database.db.selectFrom("sms_outbox").select(["phone", "text", "status", "kind"]).orderBy("created_at").execute();
const join = (driver: Record<string, string>) => call(app, "POST", "/driver/fleet/join", driver, { code: fleetCode, ownerName: "Fredrik Åkesson", ownerEmail: "fredrik@example.se" });

beforeAll(async () => {
  database = await freshDatabase();
  app = await testWorld(database.db, database.url, clock);
  owner = (await signIn(app, TEST_PHONES[0]!, "driver")).headers;
  anna = (await signIn(app, TEST_PHONES[1]!, "driver")).headers;
  bo = (await signIn(app, TEST_PHONES[2]!, "driver")).headers;
  admin = await adminSession(app, database.db, "super", { now: clock.now });
  await call(app, "POST", "/driver/onboarding", owner, details());
  annaId = (await call(app, "POST", "/driver/onboarding", anna, details({ firstName: "Anna", lastName: "Lind", email: "anna@example.se", accountType: "driver", company: undefined }))).json().driverId;
  boId = (await call(app, "POST", "/driver/onboarding", bo, details({ firstName: "Bo", lastName: "Ek", email: "bo@example.se", accountType: "driver", company: undefined, language: "en" }))).json().driverId;
  const fleet = (await call(app, "GET", "/driver/fleet", owner)).json().fleet;
  fleetId = fleet.fleetId;
  const review = await call(app, "POST", `/admin/fleets/${fleetId}/review`, admin.headers, { expectedVersion: fleet.version, decision: "approved" });
  fleetCode = review.json().code;
});
afterAll(async () => {
  await app.close();
  await database.drop();
});

describe("the owner invites a number", () => {
  let invitationId: string;

  it("refuses a bad number, his own, and a fleet account; a member may not invite", async () => {
    expect((await call(app, "POST", "/driver/fleet/invite", owner, { phone: "0701234567" })).statusCode).toBe(400);
    expect((await call(app, "POST", "/driver/fleet/invite", owner, { phone: TEST_PHONES[0] })).json()).toMatchObject({ reason: "own_phone" });
    expect((await call(app, "POST", "/driver/fleet/invite", anna, { phone: TEST_PHONES[2] })).json()).toMatchObject({ code: "forbidden", reason: "not_fleet_owner" });
  });

  it("a driver with an account is told in the app and by SMS; the owner sees it pending", async () => {
    const res = await call(app, "POST", "/driver/fleet/invite", owner, { phone: TEST_PHONES[1] });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ fleetId, fleetName: "Åkessons Taxi AB", direction: "owner_invite", status: "pending", driverId: annaId, driverName: "Anna Lind", phone: TEST_PHONES[1], version: 1 });
    invitationId = res.json().invitationId;
    expect(new Date(res.json().expiresAt).getTime() - clock.now.getTime()).toBe(7 * 24 * 3600_000);
    const list = await notices(anna);
    expect(list.items).toEqual([expect.objectContaining({ kind: "fleet_invitation", title: "Inbjudan till åkeri", read: false, data: { invitationId, direction: "owner_invite" } })]);
    expect(list.items[0].body).toContain("Åkessons Taxi AB");
    expect((await me(anna)).pendingFleetInvitations).toBe(1);
    expect((await me(owner)).pendingFleetInvitations).toBe(0);
    const mine = (await call(app, "GET", "/driver/fleet/invitations", anna)).json();
    expect(mine.items).toEqual([expect.objectContaining({ invitationId, status: "pending" })]);
    expect(mine.items[0]).not.toHaveProperty("phone");
    expect((await call(app, "GET", "/driver/fleet", owner)).json().invitations).toEqual([expect.objectContaining({ invitationId })]);
    expect(await outbox()).toEqual([{ phone: TEST_PHONES[1], text: "Åkessons Taxi AB bjuder in dig till sitt åkeri i Movera. Öppna appen för att svara.", status: "skipped", kind: "fleet_invitation" }]);
    const twice = await call(app, "POST", "/driver/fleet/invite", owner, { phone: TEST_PHONES[1] });
    expect(twice.json()).toMatchObject({ code: "conflict", reason: "invite_pending" });
  });

  it("only the invited driver may answer; the owner may cancel; declining tells the owner", async () => {
    expect((await call(app, "POST", `/driver/fleet/invitations/${invitationId}/accept`, bo)).json()).toMatchObject({ code: "forbidden", reason: "not_receiver" });
    expect((await call(app, "POST", `/driver/fleet/invitations/${invitationId}/accept`, owner)).json()).toMatchObject({ reason: "not_receiver" });
    expect((await call(app, "POST", `/driver/fleet/invitations/${invitationId}/cancel`, anna)).json()).toMatchObject({ reason: "not_sender" });
    const declined = await call(app, "POST", `/driver/fleet/invitations/${invitationId}/decline`, anna);
    expect(declined.json()).toMatchObject({ invitationId, status: "declined", version: 2 });
    expect((await call(app, "POST", `/driver/fleet/invitations/${invitationId}/accept`, anna)).json()).toMatchObject({ code: "invalid_transition", reason: "invitation_closed" });
    expect(await notice(owner, "Inbjudan avböjd")).toMatchObject({ body: "Anna Lind tackade nej till inbjudan." });
    expect((await me(anna)).pendingFleetInvitations).toBe(0);
    expect(await me(anna)).not.toHaveProperty("fleet");
  });

  it("a new invite is accepted: the driver is linked and both are told", async () => {
    const res = await call(app, "POST", "/driver/fleet/invite", owner, { phone: TEST_PHONES[1] });
    const accepted = await call(app, "POST", `/driver/fleet/invitations/${res.json().invitationId}/accept`, anna);
    expect(accepted.json()).toMatchObject({ status: "accepted", decidedAt: clock.now.toISOString() });
    expect(await me(anna)).toMatchObject({ fleet: { fleetId, role: "member" }, payoutTo: "fleet", pendingFleetInvitations: 0 });
    expect(await notice(anna, "Du är med i åkeriet")).toBeDefined();
    expect(await notice(owner, "Ny förare i åkeriet")).toMatchObject({ body: "Anna Lind är nu med i ditt åkeri." });
    expect((await call(app, "POST", "/driver/fleet/invite", owner, { phone: TEST_PHONES[1] })).json()).toMatchObject({ code: "conflict", reason: "already_in_fleet" });
  });

  it("marks a notification read once; another account's is not found", async () => {
    const unread = (await notices(owner, true)).items;
    expect(unread.length).toBeGreaterThan(0);
    const read = await call(app, "POST", `/notifications/${unread[0].notificationId}/read`, owner);
    expect(read.json()).toMatchObject({ notificationId: unread[0].notificationId, read: true });
    expect((await call(app, "POST", `/notifications/${unread[0].notificationId}/read`, owner)).json().read).toBe(true);
    expect((await call(app, "POST", `/notifications/${unread[0].notificationId}/read`, anna)).statusCode).toBe(404);
    expect((await notices(owner, true)).items).toHaveLength(unread.length - 1);
    const page = (await call(app, "GET", "/notifications?limit=1", owner)).json();
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).not.toBeNull();
    const next = (await call(app, "GET", `/notifications?limit=1&cursor=${page.nextCursor}`, owner)).json();
    expect(next.items[0].notificationId).not.toBe(page.items[0].notificationId);
  });
});

describe("a number without an account", () => {
  let invitationId: string;

  it("gets one SMS with the app link and waits with no driver", async () => {
    const res = await call(app, "POST", "/driver/fleet/invite", owner, { phone: TEST_PHONES[3] });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ direction: "owner_invite", status: "pending", phone: TEST_PHONES[3] });
    expect(res.json()).not.toHaveProperty("driverId");
    invitationId = res.json().invitationId;
    const sms = (await outbox()).filter((m) => m.phone === TEST_PHONES[3]);
    expect(sms).toHaveLength(1);
    expect(sms[0]!.text).toContain("Öppna appen för att svara.");
    // Nobody can accept it yet, not even an admin.
    expect((await call(app, "POST", `/admin/fleets/${fleetId}/invitations/${invitationId}/accept`, admin.headers)).json()).toMatchObject({ reason: "driver_not_signed_up" });
  });

  it("becomes the driver's the moment that number signs up; an admin may accept it", async () => {
    const newcomer = (await signIn(app, TEST_PHONES[3]!, "driver")).headers;
    const fresh = await me(newcomer);
    expect(fresh).toMatchObject({ accountStatus: "pending" });
    const mine = (await call(app, "GET", "/driver/fleet/invitations", newcomer)).json();
    expect(mine.items).toEqual([expect.objectContaining({ invitationId, driverId: fresh.driverId, status: "pending" })]);
    expect((await notices(newcomer)).items).toEqual([expect.objectContaining({ kind: "fleet_invitation", data: { invitationId, direction: "owner_invite" } })]);
    await call(app, "POST", "/driver/onboarding", newcomer, details({ firstName: "Nils", lastName: "Ny", email: "nils@example.se", accountType: "driver", company: undefined }));
    expect((await me(newcomer)).pendingFleetInvitations).toBe(1);
    const detail = (await call(app, "GET", `/admin/fleets/${fleetId}`, admin.headers)).json();
    expect(detail.invitations).toEqual([expect.objectContaining({ invitationId, driverName: "Nils Ny", phone: TEST_PHONES[3] })]);
    const accepted = await call(app, "POST", `/admin/fleets/${fleetId}/invitations/${invitationId}/accept`, admin.headers);
    expect(accepted.json()).toMatchObject({ status: "accepted" });
    expect(await me(newcomer)).toMatchObject({ fleet: { fleetId, role: "member" } });
    const audit = await database.db.selectFrom("admin_audit").select("action").where("target_id", "=", fleetId).where("action", "=", "fleet.invitation.accept").executeTakeFirst();
    expect(audit).toBeDefined();
  });
});

describe("the driver asks with the code", () => {
  let requestId: string;

  it("a request waits for the owner; the driver may cancel his own", async () => {
    const res = await join(bo);
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ direction: "driver_request", status: "pending", driverId: boId, driverName: "Bo Ek" });
    requestId = res.json().invitationId;
    expect((await me(owner)).pendingFleetInvitations).toBe(1);
    expect(await notice(owner, "Förare vill gå med")).toMatchObject({ body: "Bo Ek vill gå med i Åkessons Taxi AB. Svara i Mitt åkeri." });
    expect((await outbox()).filter((m) => m.phone === TEST_PHONES[0])).toEqual([expect.objectContaining({ text: "Bo Ek vill gå med i Åkessons Taxi AB i Movera. Öppna appen för att svara." })]);
    expect((await call(app, "POST", `/driver/fleet/invitations/${requestId}/accept`, bo)).json()).toMatchObject({ reason: "not_receiver" });
    const cancelled = await call(app, "POST", `/driver/fleet/invitations/${requestId}/cancel`, bo);
    expect(cancelled.json()).toMatchObject({ status: "cancelled" });
    expect(await notice(owner, "Inbjudan återkallad")).toMatchObject({ body: "Bo Ek tog tillbaka sin förfrågan." });
    expect((await me(owner)).pendingFleetInvitations).toBe(0);
  });

  it("the owner declines a request; the driver is told in his language", async () => {
    const res = await join(bo);
    const declined = await call(app, "POST", `/driver/fleet/invitations/${res.json().invitationId}/decline`, owner);
    expect(declined.json()).toMatchObject({ status: "declined" });
    expect(await notice(bo, "Invitation declined")).toMatchObject({ body: "Åkessons Taxi AB declined your request." });
  });

  it("an owner's invite meets an open request: linked at once (and the other way round)", async () => {
    const request = await join(bo);
    const invite = await call(app, "POST", "/driver/fleet/invite", owner, { phone: TEST_PHONES[2] });
    expect(invite.statusCode).toBe(201);
    expect(invite.json()).toMatchObject({ invitationId: request.json().invitationId, direction: "driver_request", status: "accepted" });
    expect(await me(bo)).toMatchObject({ fleet: { fleetId, role: "member" } });
    // Leave, then the owner invites first and the driver's request is his acceptance.
    await call(app, "POST", "/driver/fleet/leave", bo);
    const invite2 = await call(app, "POST", "/driver/fleet/invite", owner, { phone: TEST_PHONES[2] });
    const request2 = await join(bo);
    expect(request2.statusCode).toBe(201);
    expect(request2.json()).toMatchObject({ invitationId: invite2.json().invitationId, direction: "owner_invite", status: "accepted" });
    expect(await me(bo)).toMatchObject({ fleet: { fleetId, role: "member" } });
    await call(app, "POST", "/driver/fleet/leave", bo);
  });

  it("an admin cancels a request; an expired one cannot be answered", async () => {
    const res = await join(bo);
    const cancelled = await call(app, "POST", `/admin/fleets/${fleetId}/invitations/${res.json().invitationId}/cancel`, admin.headers);
    expect(cancelled.json()).toMatchObject({ status: "cancelled" });
    expect(await notice(bo, "Invitation withdrawn")).toBeDefined();
    const late = await join(bo);
    // Seven days pass (the tokens would expire with the clock, so the row is aged instead; the profile badge reads the database clock).
    await database.db.updateTable("fleet_invitations").set({ expires_at: new Date(clock.now.getTime() - 2 * 24 * 3600_000) }).where("invitation_id", "=", late.json().invitationId).execute();
    expect((await call(app, "GET", "/driver/fleet/invitations", bo)).json().items).toEqual([]);
    expect((await me(owner)).pendingFleetInvitations).toBe(0);
    const expired = await call(app, "POST", `/driver/fleet/invitations/${late.json().invitationId}/accept`, owner);
    expect(expired.json()).toMatchObject({ code: "invalid_transition", reason: "invitation_expired" });
    expect(expired.json().projection).toMatchObject({ status: "expired" });
    // Gone for good: a new request may follow.
    expect((await join(bo)).statusCode).toBe(201);
    await call(app, "POST", `/driver/fleet/invitations/${(await call(app, "GET", "/driver/fleet/invitations", bo)).json().items[0].invitationId}/cancel`, bo);
  });

  it("blocking the fleet cancels its open invitations", async () => {
    const open = await join(bo);
    const fleet = (await call(app, "GET", `/admin/fleets/${fleetId}`, admin.headers)).json().fleet;
    await call(app, "POST", `/admin/fleets/${fleetId}/review`, admin.headers, { expectedVersion: fleet.version, decision: "blocked" });
    const row = await database.db.selectFrom("fleet_invitations").select("status").where("invitation_id", "=", open.json().invitationId).executeTakeFirstOrThrow();
    expect(row.status).toBe("cancelled");
    expect((await call(app, "GET", "/driver/fleet/invitations", bo)).json().items).toEqual([]);
  });
});
