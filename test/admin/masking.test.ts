import { describe, expect, it } from "vitest";
import { adminMasksDrivers, adminMasksRiders, maskDateOfBirth, maskDriverView, maskEmail, maskFleetView, maskPhone, maskRiderView } from "../../src/admin/masking.js";

/** contract v0.18.54 §76 (contract.json#adminMasking.shapes): the masked shapes, against the contract's examples. */
describe("admin masking shapes (v0.18.54 §76)", () => {
  it("phone: country code, one • per hidden digit, the last two digits", () => {
    expect(maskPhone("+46701234512")).toBe("+46•••••••12");
    expect(maskPhone("+33612345678")).toBe("+33•••••••78");
    expect(maskPhone("+21620123456")).toBe("+216••••••56");
    // Not a zone country: the longest 1–3 digit match is taken as the code; the two last digits stay.
    expect(maskPhone("+4917612345678")).toBe("+491••••••••78");
    // Never fewer than one •.
    expect(maskPhone("+4612")).toBe("+46•12");
    expect(maskPhone("+461")).toBe("+46•1");
    expect(maskPhone("")).toBe("•");
  });
  it("e-mail: the first character + •••@ + the domain", () => {
    expect(maskEmail("anna@example.com")).toBe("a•••@example.com");
    expect(maskEmail("a@b.se")).toBe("a•••@b.se");
    expect(maskEmail("no-at-sign")).toBe("n•••@");
  });
  it("date of birth: the year only", () => {
    expect(maskDateOfBirth("1990-05-17")).toBe("1990");
    expect(maskDateOfBirth("1990")).toBe("1990");
  });
  it("who is masked: the admin lacks the matching viewSensitive right; no perms at all = masked", () => {
    expect(adminMasksRiders({ perms: ["riders.read"] })).toBe(true);
    expect(adminMasksRiders({ perms: ["riders.read", "riders.viewSensitive"] })).toBe(false);
    expect(adminMasksDrivers({ perms: ["drivers.read"] })).toBe(true);
    expect(adminMasksDrivers({ perms: ["drivers.viewSensitive"] })).toBe(false);
    expect(adminMasksRiders({})).toBe(true);
    expect(adminMasksDrivers(undefined)).toBe(true);
  });
  it("views: masked fields plus sensitiveMasked true; untouched (no flag) for an admin with the right", () => {
    const rider = { riderId: "r1", phone: "+46701234512", email: "anna@example.com", status: "active" };
    expect(maskRiderView(rider, { perms: ["riders.read"] })).toEqual({ riderId: "r1", phone: "+46•••••••12", email: "a•••@example.com", status: "active", sensitiveMasked: true });
    expect(maskRiderView(rider, { perms: ["riders.viewSensitive"] })).toBe(rider);
    const driver = { driverId: "d1", email: "bo@example.com", dateOfBirth: "1990-05-17", firstName: "Bo" };
    expect(maskDriverView(driver, { perms: [] })).toEqual({ driverId: "d1", email: "b•••@example.com", dateOfBirth: "1990", firstName: "Bo", sensitiveMasked: true });
    expect(maskDriverView({ ...driver, phone: "+46701234512" }, { perms: [] })["phone"]).toBe("+46•••••••12");
    // Nothing to mask (no e-mail, no date of birth): no flag either.
    expect(maskDriverView({ driverId: "d2", firstName: "Al" }, { perms: [] })).toEqual({ driverId: "d2", firstName: "Al" });
    const fleet = { fleetId: "f1", ownerEmail: "owner@fleet.example.com", name: "Fleet" };
    expect(maskFleetView(fleet, { perms: ["drivers.read"] })).toEqual({ fleetId: "f1", ownerEmail: "o•••@fleet.example.com", name: "Fleet", sensitiveMasked: true });
    expect(maskFleetView(fleet, { perms: ["drivers.viewSensitive"] })).toBe(fleet);
  });
});
