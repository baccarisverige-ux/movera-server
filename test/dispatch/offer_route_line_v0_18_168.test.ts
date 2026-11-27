import { describe, expect, it } from "vitest";
import { offerView, type OfferRow } from "../../src/dispatch/runtime/offers.js";
import type { TripRow } from "../../src/db/tripLog.js";

// v0.18.168 (contract.json#offerRouteLine, owner 2026-11-26 "Route in driver !!"): an open offer carries the trip's
// stored Google route (trips.route_polyline, from its quote; no new call); a closed one, or a trip without one, does not.
const LINE = "_p~iF~ps|U_ulLnnqC_mqNvxq`@";
const offer = (status: string) =>
  ({
    offer_id: "ofr_1", trip_id: "trp_1", kind: "exclusive", status, version: 1, expires_at: new Date("2026-11-26T20:00:00Z"),
    currency: "SEK", fare_minor: 50000, driver_earnings_minor: 40000, pickup_pay_minor: 0, source: "dispatch", group_id: null,
    pickup_eta_seconds: 60, pickup_meters: 300, rider_rating: null,
  }) as unknown as NonNullable<OfferRow>;
const trip = (routePolyline: string | null) =>
  ({
    trip_id: "trp_1", pickup: { lat: 59.2, lng: 17.6 }, dropoff: { lat: 59.65, lng: 17.93 }, stops: [], category_id: "economy",
    payment_method: "cash", wallet_applied_minor: 0, duration_seconds: 3600, distance_meters: 60000, scheduled_at: null,
    kind: "live", route_polyline: routePolyline,
  }) as unknown as TripRow;

describe("Offer.routePolyline (v0.18.168)", () => {
  it("an open offer carries the trip's stored Google route", () => {
    expect(offerView(offer("open"), trip(LINE))).toMatchObject({ routePolyline: LINE, tripSeconds: 3600 });
  });
  it("closed offers and trips without a stored route carry none", () => {
    for (const status of ["withdrawn", "expired", "declined", "accepted", "claimed_elsewhere"]) expect(offerView(offer(status), trip(LINE))).not.toHaveProperty("routePolyline");
    expect(offerView(offer("open"), trip(null))).not.toHaveProperty("routePolyline");
  });
});
