import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { CONTRACTS_DIR } from "../../src/contract/contract.js";

/** Live clean-up 1 (contract v0.18.13): no fleet-owner % anywhere (owner G10-1); the served refund routes are documented (audit M4). */
const contract = JSON.parse(readFileSync(`${CONTRACTS_DIR}/contract.json`, "utf8"));
const openapi = parse(readFileSync(`${CONTRACTS_DIR}/openapi.yaml`, "utf8"));

describe("contract v0.18.13 clean-up", () => {
  it("fleetCommissionPct is gone from the pricing schema, the defaults and the sample (SE and FR use the same schema)", () => {
    const schema = openapi.components.schemas.PricingDocument;
    expect(Object.keys(schema.properties)).not.toContain("fleetCommissionPct");
    expect(schema.required).not.toContain("fleetCommissionPct");
    expect(JSON.parse(readFileSync(`${CONTRACTS_DIR}/fixtures/config/pricing_document.json`, "utf8"))).not.toHaveProperty("fleetCommissionPct");
    expect(JSON.stringify(contract.configDefaults)).not.toContain("fleetCommissionPct");
  });

  it("the four refund routes the server serves are in openapi paths", () => {
    expect(openapi.paths["/rider/refunds"].get["x-actor"]).toEqual(["rider"]);
    expect(openapi.paths["/rider/refunds/{refundId}/destination"].post["x-actor"]).toEqual(["rider"]);
    expect(openapi.paths["/admin/refunds/payouts"].get["x-permission"]).toBe("finance.read");
    expect(openapi.paths["/admin/refunds/{refundId}/paid"].post["x-permission"]).toBe("finance.edit");
  });
});
