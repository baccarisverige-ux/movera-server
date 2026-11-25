import { describe, expect, it } from "vitest";
import { ageYear, carRuleProblems, driverReadSettings, categoryProblem, defaultSettings, settingsProblems, typeInfo } from "../../src/drivers/onboardingSettings.js";

/** Contract v0.18.164 (owner 2026-11-25, France document lists): vehicleRules.maxAge, REVTC 60 months, owner fleet. */
const year = new Date().getUTCFullYear();

describe("v0.18.164 France car age (Moins de 6 ans, hybrid/electric exempt)", () => {
  it("FR: rolling 6 years; 2026 means 2020 or newer", () => {
    const fr = defaultSettings("FR");
    expect(fr.vehicles.maxAgeYears).toBe(6);
    expect(fr.vehicles.hybridElectricExempt).toBe(true);
    expect(ageYear(fr, { fuel: "petrol" }, new Date("2026-11-25T00:00:00Z"))).toBe(2020);
    expect(ageYear(fr, { fuel: "petrol" }, new Date("2027-01-01T00:00:00Z"))).toBe(2021);
    expect(ageYear(fr, { fuel: "electric" })).toBeNull();
    expect(ageYear(fr, { fuel: "hybrid" })).toBeNull();
    expect(ageYear(fr, { fuel: null })).toBe(year - 6);
  });
  it("FR: an old petrol car is refused, the same hybrid or electric car is not", () => {
    const fr = defaultSettings("FR");
    expect(categoryProblem({ year: year - 7, seats: 4, fuel: "petrol" }, fr, "economy")).toBe("year_too_old");
    expect(categoryProblem({ year: year - 6, seats: 4, fuel: "diesel" }, fr, "economy")).toBeNull();
    expect(categoryProblem({ year: year - 7, seats: 4, fuel: "hybrid" }, fr, "economy")).toBeNull();
    expect(categoryProblem({ year: year - 7, seats: 4, fuel: "electric" }, fr, "child_seat")).toBeNull();
    expect(carRuleProblems({ year: year - 7, seats: 4, fuel: "diesel" }, fr, [])).toEqual(["car:year_too_old"]);
    expect(carRuleProblems({ year: year - 7, seats: 4, fuel: "hybrid" }, fr, [])).toEqual([]);
  });
  it("FR: minYear still applies to an exempt car", () => {
    const fr = defaultSettings("FR");
    expect(categoryProblem({ year: 2015, seats: 4, fuel: "electric" }, fr, "economy")).toBe("year_too_old");
  });
  it("FR exempt toggle off: hybrid and electric are held to the age too", () => {
    const fr = defaultSettings("FR");
    fr.vehicles.hybridElectricExempt = false;
    expect(categoryProblem({ year: year - 7, seats: 4, fuel: "electric" }, fr, "economy")).toBe("year_too_old");
  });
  it("Sweden and Tunisia keep the base year rule unchanged (no maxAgeYears)", () => {
    for (const cc of ["SE", "TN"]) {
      const s = defaultSettings(cc);
      expect(s.vehicles.maxAgeYears).toBeUndefined();
      expect(ageYear(s, { fuel: "petrol" })).toBeNull();
    }
    expect(categoryProblem({ year: 2015, seats: 4, fuel: "petrol" }, defaultSettings("SE"), "economy")).toBeNull();
  });
  it("driver read: category years raised to the age year (the app's 'from {year}' text); SE unchanged", () => {
    const fr = driverReadSettings(defaultSettings("FR"), new Date("2026-11-25T00:00:00Z"));
    expect(fr.vehicles.categories.find((r) => r.category === "economy")?.minYear).toBe(2020);
    expect(fr.vehicles.categories.find((r) => r.category === "premium")?.minYear).toBe(2022);
    expect(defaultSettings("FR").vehicles.categories.find((r) => r.category === "economy")?.minYear).toBe(2016);
    const se = defaultSettings("SE");
    expect(driverReadSettings(se, new Date())).toBe(se);
  });
  it("the admin setting is checked: 1 to 30 years, the toggle a boolean", () => {
    const fr = defaultSettings("FR");
    expect(settingsProblems(fr)).toEqual([]);
    expect(settingsProblems({ ...fr, vehicles: { ...fr.vehicles, maxAgeYears: 0 } })).toContain("vehicles.maxAgeYears: 1 to 30 years");
    expect(settingsProblems({ ...fr, vehicles: { ...fr.vehicles, maxAgeYears: 31 } })).toContain("vehicles.maxAgeYears: 1 to 30 years");
    expect(settingsProblems({ ...fr, vehicles: { ...fr.vehicles, hybridElectricExempt: "yes" as unknown as boolean } })).toContain("vehicles.hybridElectricExempt: true or false");
  });
});

describe("v0.18.164 France documents", () => {
  it("REVTC valid 60 months, no contrôle technique", () => {
    const fr = defaultSettings("FR");
    expect(fr.validMonths?.vtc_register_certificate).toBe(60);
    expect(fr.validMonths?.urssaf_certificate).toBe(6);
    expect([...fr.documents.driver, ...fr.documents.fleet, ...fr.documents.vehicle]).not.toContain("controle_technique");
  });
  it("company papers have owner fleet in the contract; server behaviour unchanged", () => {
    const fr = defaultSettings("FR");
    expect(typeInfo(fr, "rc_pro_insurance")?.owner).toBe("fleet");
    expect(typeInfo(fr, "vtc_card")?.owner).toBe("driver");
    // A company paper may still sit in the person list, exactly as before v0.18.164.
    expect(settingsProblems({ ...fr, documents: { ...fr.documents, driver: [...fr.documents.driver, "company_registration"] } })).toEqual([]);
    expect(settingsProblems({ ...fr, documents: { ...fr.documents, vehicle: [...fr.documents.vehicle, "rc_pro_insurance"] } })).toContain("documents.vehicle: rc_pro_insurance belongs to a person");
  });
  it("FR insurance guide: the owner's one short line (plate + 'transport de personnes à titre onéreux'; details in the reject note)", () => {
    const g = typeInfo(defaultSettings("FR"), "insurance")?.guide;
    for (const l of ["fr", "en", "sv"] as const) expect(g?.checklist?.[0]?.[l]).toContain("transport de personnes à titre onéreux");
    expect(g?.checklist?.[0]?.en).toContain("A normal insurance is not enough");
    expect(g?.checklist).toHaveLength(1);
  });
  it("FR fleet = Uber FR: Kbis, REVTC, RC Pro, RIB; the ID once; URSSAF not required; macaron + 4 photos kept", () => {
    const fr = defaultSettings("FR");
    expect(fr.documents.fleet).toEqual(["company_registration", "vtc_register_certificate", "rc_pro_insurance", "bank_statement"]);
    expect(fr.documents.driver).toContain("national_id");
    expect(fr.documents.vehicle).toEqual(["vehicle_registration", "insurance", "vtc_sticker"]);
    expect(fr.vehicles.photosNeeded).toBe(true);
    expect(typeInfo(fr, "urssaf_certificate")).toBeDefined();
  });
});
