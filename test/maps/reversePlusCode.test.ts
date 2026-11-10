import { describe, expect, it } from "vitest";
import { GooglePlaces, pickReverseAddress } from "../../src/maps/places.js";

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
  it("a street result far from the point (Mareth for Av. Habib Bourguiba) is skipped", async () => {
    const google = new GooglePlaces("test-key-123456", "tn", answer([
      { formatted_address: "8FQW+X2 Tunis", types: ["plus_code"], geometry: { location: { lat: 36.8008, lng: 10.18 } } },
      { formatted_address: "9 Rue d'Alger, Mareth 6080, Tunisie", types: ["street_address"], geometry: { location: { lat: 33.63, lng: 10.29 } } },
      { formatted_address: "Avenue Habib Bourguiba, Tunis, Tunisie", types: ["route"], geometry: { location: { lat: 36.8, lng: 10.181 } } },
    ]));
    expect(await google.reverse({ lat: 36.8008, lng: 10.18, language: "fr" })).toBe("Avenue Habib Bourguiba, Tunis, Tunisie");
  });
  it("a street result in another town is skipped even when Google puts it near the point (Tunis re-check)", async () => {
    const town = (name: string) => [{ long_name: name, types: ["locality", "political"] }];
    const google = new GooglePlaces("test-key-123456", "tn", answer([
      { formatted_address: "9 Rue d'Alger, Mareth 6080, Tunisie", types: ["street_address"], geometry: { location: { lat: 36.8009, lng: 10.1801 } }, address_components: town("Mareth") },
      { formatted_address: "Avenue Habib Bourguiba, Tunis, Tunisie", types: ["route"], geometry: { location: { lat: 36.8, lng: 10.181 } }, address_components: town("Tunis") },
      { formatted_address: "Tunis, Tunisie", types: ["locality", "political"], address_components: town("Tunis") },
    ]));
    expect(await google.reverse({ lat: 36.8008, lng: 10.18, language: "fr" })).toBe("Avenue Habib Bourguiba, Tunis, Tunisie");
  });
  it("same town or no town given → the street result is kept", () => {
    const t = [{ long_name: "Tunis", types: ["locality"] }];
    expect(pickReverseAddress([
      { formatted_address: "12 Rue de Marseille, Tunis", types: ["street_address"], address_components: t },
      { formatted_address: "Tunis", types: ["locality"], address_components: t },
    ])).toBe("12 Rue de Marseille, Tunis");
    expect(pickReverseAddress([{ formatted_address: "12 Rue X", types: ["street_address"] }, { formatted_address: "Tunis", types: ["locality"], address_components: t }])).toBe("12 Rue X");
  });
});
