import { describe, expect, it } from "vitest";
import { GooglePlaces } from "../../src/maps/places.js";

/**
 * Same-address fix (contract v0.18.42 §67): a picked suggestion is resolved by its placeId and the answer carries the place's own
 * name. Proven case: "Solna Centrum" came back only as Google's formatted_address "Solnavägen 13, 171 45 Solna, Sverige".
 */
describe("geocode by placeId answers the place name", () => {
  it("uses Place Details (New) for a placeId and returns name + address + location", async () => {
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> });
      if (String(url).startsWith("https://places.googleapis.com/v1/places/ChIJSolna")) {
        return new Response(JSON.stringify({ id: "ChIJSolna", displayName: { text: "Solna Centrum" }, formattedAddress: "Solnavägen 13, 171 45 Solna, Sverige", location: { latitude: 59.3596729, longitude: 18.0005394 } }));
      }
      return new Response(JSON.stringify({ status: "OK", results: [{ formatted_address: "Solnavägen 13, 171 45 Solna, Sverige", place_id: "ChIJSolna", geometry: { location: { lat: 59.3596729, lng: 18.0005394 } } }] }));
    }) as typeof fetch;
    const google = new GooglePlaces("test-key-123456", "se", fetcher);
    const result = await google.geocode({ query: "Solna Centrum, Solnavägen, Solna, Sverige", placeId: "ChIJSolna", language: "sv", session: "sess-1" });
    expect(result).toEqual({ name: "Solna Centrum", address: "Solnavägen 13, 171 45 Solna, Sverige", latitude: 59.3596729, longitude: 18.0005394, placeId: "ChIJSolna" });
    const details = seen.find((s) => s.url.includes("/v1/places/ChIJSolna"))!;
    expect(details.url).toContain("languageCode=sv");
    expect(details.url).toContain("sessionToken=sess-1");
    expect(details.headers["x-goog-fieldmask"]).toBe("id,displayName,formattedAddress,location");
  });
  it("falls back to the Geocoding API by place_id when Place Details has no location (no name then)", async () => {
    const fetcher = (async (url: string | URL | Request) => {
      if (String(url).startsWith("https://places.googleapis.com/v1/places/")) return new Response("{}", { status: 500 });
      return new Response(JSON.stringify({ status: "OK", results: [{ formatted_address: "Solnavägen 13", place_id: "ChIJSolna", geometry: { location: { lat: 59.35, lng: 18.0 } } }] }));
    }) as typeof fetch;
    const google = new GooglePlaces("test-key-123456", "se", fetcher);
    expect(await google.geocode({ query: "Solna Centrum", placeId: "ChIJSolna", language: "sv" })).toEqual({ address: "Solnavägen 13", latitude: 59.35, longitude: 18.0, placeId: "ChIJSolna" });
  });
  it("a typed address (no placeId) has no name", async () => {
    const fetcher = (async () => new Response(JSON.stringify({ status: "OK", results: [{ formatted_address: "Sergels torg, Stockholm", geometry: { location: { lat: 59.33, lng: 18.06 } } }] }))) as unknown as typeof fetch;
    const google = new GooglePlaces("test-key-123456", "se", fetcher);
    expect((await google.geocode({ query: "Sergels torg", language: "sv" })).name).toBeUndefined();
  });
});
