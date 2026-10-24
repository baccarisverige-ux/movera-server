/**
 * Address search (contract §10; owner decision 4: Google Places / Geocoding through the server). The server keeps
 * the key, the provider's session tokens and a short cache, so the apps never see a Google key.
 */

export type Suggestion = { title: string; subtitle?: string; latitude?: number; longitude?: number; placeId?: string };
export type GeocodeResult = { address?: string; latitude?: number; longitude?: number; placeId?: string };

export interface Places {
  autocomplete(input: { query: string; bias?: { lat: number; lng: number }; limit: number; language: string; session: string }): Promise<Suggestion[]>;
  geocode(input: { query: string; placeId?: string; language: string; session?: string }): Promise<GeocodeResult>;
  reverse(input: { lat: number; lng: number; language: string }): Promise<string | null>;
}

export class PlacesUnavailable extends Error {}

/** No key configured: every call says so, and the apps fall back to their own behaviour. */
export class NoPlaces implements Places {
  async autocomplete(): Promise<Suggestion[]> {
    throw new PlacesUnavailable("No GOOGLE_MAPS_API_KEY");
  }
  async geocode(): Promise<GeocodeResult> {
    throw new PlacesUnavailable("No GOOGLE_MAPS_API_KEY");
  }
  async reverse(): Promise<string | null> {
    throw new PlacesUnavailable("No GOOGLE_MAPS_API_KEY");
  }
}

type Fetch = typeof fetch;

/** Google Places API (New) autocomplete + Geocoding API, biased to Sweden. */
export class GooglePlaces implements Places {
  constructor(
    private readonly key: string,
    private readonly region = "se",
    private readonly fetcher: Fetch = fetch,
    private readonly timeoutMs = 3000,
  ) {}

  private async json(url: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await this.fetcher(url, { ...init, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (error) {
      throw new PlacesUnavailable(`Google did not answer: ${(error as Error).message}`);
    }
    if (!response.ok) throw new PlacesUnavailable(`Google answered ${response.status}`);
    return (await response.json()) as Record<string, unknown>;
  }

  async autocomplete(input: { query: string; bias?: { lat: number; lng: number }; limit: number; language: string; session: string }): Promise<Suggestion[]> {
    const body = {
      input: input.query,
      languageCode: input.language,
      includedRegionCodes: [this.region],
      sessionToken: input.session,
      ...(input.bias ? { locationBias: { circle: { center: { latitude: input.bias.lat, longitude: input.bias.lng }, radius: 30000 } } } : {}),
    };
    const data = await this.json("https://places.googleapis.com/v1/places:autocomplete", {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": this.key },
      body: JSON.stringify(body),
    });
    const items = (data["suggestions"] as Array<{ placePrediction?: { placeId?: string; structuredFormat?: { mainText?: { text?: string }; secondaryText?: { text?: string } }; text?: { text?: string } } }> | undefined) ?? [];
    const out: Suggestion[] = [];
    for (const item of items) {
      const p = item.placePrediction;
      const title = p?.structuredFormat?.mainText?.text ?? p?.text?.text;
      if (!p || !title) continue;
      const subtitle = p.structuredFormat?.secondaryText?.text;
      out.push({ title, ...(subtitle ? { subtitle } : {}), ...(p.placeId ? { placeId: p.placeId } : {}) });
      if (out.length >= input.limit) break;
    }
    return out;
  }

  private geocodeUrl(params: Record<string, string>): string {
    const url = new URL("https://maps.googleapis.com/maps/api/geocode/json");
    for (const [k, v] of Object.entries({ ...params, key: this.key })) url.searchParams.set(k, v);
    return url.toString();
  }

  async geocode(input: { query: string; placeId?: string; language: string }): Promise<GeocodeResult> {
    const data = await this.json(this.geocodeUrl(input.placeId ? { place_id: input.placeId, language: input.language } : { address: input.query, language: input.language, region: this.region }));
    const status = data["status"];
    if (status === "ZERO_RESULTS") return {};
    if (status !== "OK") throw new PlacesUnavailable(`Geocoding status ${String(status)}`);
    const first = (data["results"] as Array<{ formatted_address?: string; place_id?: string; geometry?: { location?: { lat: number; lng: number } } }>)[0];
    if (!first?.geometry?.location) return {};
    return {
      ...(first.formatted_address ? { address: first.formatted_address } : {}),
      latitude: first.geometry.location.lat,
      longitude: first.geometry.location.lng,
      ...(first.place_id ? { placeId: first.place_id } : {}),
    };
  }

  async reverse(input: { lat: number; lng: number; language: string }): Promise<string | null> {
    const data = await this.json(this.geocodeUrl({ latlng: `${input.lat},${input.lng}`, language: input.language }));
    if (data["status"] === "ZERO_RESULTS") return null;
    if (data["status"] !== "OK") throw new PlacesUnavailable(`Geocoding status ${String(data["status"])}`);
    return (data["results"] as Array<{ formatted_address?: string }>)[0]?.formatted_address ?? null;
  }
}

/** A small time-limited cache in front of any Places (answers for the same question repeat a lot while typing). */
export class CachedPlaces implements Places {
  private readonly cache = new Map<string, { at: number; value: unknown }>();

  constructor(
    private readonly inner: Places,
    private readonly ttlMs = 60 * 60 * 1000,
    private readonly max = 5000,
    private readonly clock: () => number = Date.now,
  ) {}

  private async remember<T>(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key);
    if (hit && this.clock() - hit.at < this.ttlMs) return hit.value as T;
    const value = await load();
    if (this.cache.size >= this.max) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(key, { at: this.clock(), value });
    return value;
  }

  autocomplete(input: Parameters<Places["autocomplete"]>[0]) {
    const bias = input.bias ? `${input.bias.lat.toFixed(2)},${input.bias.lng.toFixed(2)}` : "";
    return this.remember(`a|${input.language}|${bias}|${input.limit}|${input.query.toLowerCase()}`, () => this.inner.autocomplete(input));
  }
  geocode(input: Parameters<Places["geocode"]>[0]) {
    return this.remember(`g|${input.language}|${input.placeId ?? ""}|${input.query.toLowerCase()}`, () => this.inner.geocode(input));
  }
  reverse(input: Parameters<Places["reverse"]>[0]) {
    return this.remember(`r|${input.language}|${input.lat.toFixed(5)},${input.lng.toFixed(5)}`, () => this.inner.reverse(input));
  }
}
