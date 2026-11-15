import { describe, expect, it } from "vitest";
import { internationalPhone, sosSmsNumber, sosSmsText } from "../../src/safety/sosContactsSms.js";

/** v0.18.101 §92 (contract.json#sosContactsSms.phone / .text): numbers and the SMS text of the driver's SOS. */
describe("sosContactsSms phone rule", () => {
  it("keeps +, turns 00 into +, puts the zone country's calling code before a leading 0 or a bare number", () => {
    expect(internationalPhone("+33612345678", "SE")).toBe("+33612345678");
    expect(internationalPhone("0046701112233", "FR")).toBe("+46701112233");
    expect(internationalPhone("0701234567", "SE")).toBe("+46701234567");
    expect(internationalPhone("0612345678", "FR")).toBe("+33612345678");
    expect(internationalPhone("22123456", "TN")).toBe("+21622123456");
    expect(internationalPhone("0701234567", "DE")).toBe("0701234567");
  });

  // Supervisor S2 (Rules audits/impact/v34-driver-sos-supervisor.md): a number typed international without + gets the code once.
  it("does not double the calling code of a number typed international without + (SE, FR, TN)", () => {
    expect(internationalPhone("46701234567", "SE")).toBe("+46701234567");
    expect(internationalPhone("33612345678", "FR")).toBe("+33612345678");
    expect(internationalPhone("21622123456", "TN")).toBe("+21622123456");
    expect(internationalPhone("701234567", "SE")).toBe("+46701234567");
    expect(internationalPhone("612345678", "FR")).toBe("+33612345678");
  });

  it("only a number matching ^\\+[1-9]\\d{6,14}$ is ever used; anything else is null", () => {
    expect(sosSmsNumber("0701234567", "SE")).toBe("+46701234567");
    expect(sosSmsNumber("0612345678", "FR")).toBe("+33612345678");
    expect(sosSmsNumber("22123456", "TN")).toBe("+21622123456");
    for (const bad of ["000", "00", "0", "123", "+0123456789", "0701234567x"]) expect(sosSmsNumber(bad, "SE")).toBeNull();
    expect(sosSmsNumber("0701234567", "DE")).toBeNull();
    expect(sosSmsNumber(undefined as unknown as string, "SE")).toBeNull();
  });
});

describe("sosContactsSms text", () => {
  // Supervisor S3: a "$&" or "$1" in a first name is written as typed.
  it("writes $& and $1 in the driver's name as typed", () => {
    const text = sosSmsText("en", { driver: "A$&b$1", position: null, emergency: "112" });
    expect(text).toBe("Movera SOS: A$&b$1 pressed SOS during a trip and may need help. Position not available. Call A$&b$1 or 112.");
  });

  it("fills first name, map link (6 decimals) and the country's first emergency number, in sv / fr / en", () => {
    expect(sosSmsText("en", { driver: "Ali", position: { lat: 59.3331, lng: 18.0651 }, emergency: "112" }))
      .toBe("Movera SOS: Ali pressed SOS during a trip and may need help. Position: https://maps.google.com/?q=59.333100,18.065100. Call Ali or 112.");
    expect(sosSmsText("fr", { driver: "Ali", position: { lat: 36.8, lng: 10.18 }, emergency: "197" })).toContain("https://maps.google.com/?q=36.800000,10.180000");
    expect(sosSmsText("sv", { driver: "Ali", position: null, emergency: "112" })).toBe("Movera SOS: Ali tryckte på SOS under en resa och kan behöva hjälp. Position saknas. Ring Ali eller 112.");
    expect(sosSmsText("fr", { driver: "Ali", position: null, emergency: "112" })).toContain("besoin d’aide. Position inconnue. Appelez Ali ou le 112.");
  });
});
