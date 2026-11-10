import { describe, expect, it } from "vitest";
import { GooglePlaces } from "../../src/maps/places.js";

/** Owner 2026-11-10 (Tunis real-phone test): reverse geocode must answer a street/place name, a Plus Code only as last fallback. */
const answer = (results: unknown[]) => (async () => new Response(JSON.stringify({ status: "OK", results }))) as unknown as typeof fetch;

describe("reverse geocode skips Plus Codes", () => {
  it("plus_code result first → the street result is chosen", async () => {
    const google = new GooglePlaces("test-key-123456", "tn", answer([
      { formatted_address: "8FQW+X2 Tunis, Tunisie", types: ["plus_code"] },
      { formatted_address: "Avenue Habib Bourguiba, Tunis, Tunisie", types: ["route"] },
      { formatted_address: "Tunis, Tunisie", types: ["locality", "political"] },
    ]));
    expect(await google.reverse({ lat: 36.8, lng: 10.18, language: "fr" })).toBe("Avenue Habib Bourguiba, Tunis, Tunisie");
  });
  it("prefers a street/place over a broader area listed earlier", async () => {
    const google = new GooglePlaces("test-key-123456", "tn", answer([
      { formatted_address: "8FQW+X2 Tunis", types: ["plus_code"] },
      { formatted_address: "Tunis, Tunisie", types: ["locality", "political"] },
      { formatted_address: "12 Rue de Marseille, Tunis", types: ["street_address"] },
    ]));
    expect(await google.reverse({ lat: 36.8, lng: 10.18, language: "fr" })).toBe("12 Rue de Marseille, Tunis");
  });
  it("only a plus_code result → the Plus Code is the last fallback", async () => {
    const google = new GooglePlaces("test-key-123456", "tn", answer([{ formatted_address: "8FQW+X2 Tunis", types: ["plus_code"] }]));
    expect(await google.reverse({ lat: 36.8, lng: 10.18, language: "fr" })).toBe("8FQW+X2 Tunis");
  });
});
