/**
 * B1.3 (owner W1 Q67, 2026-11-11): defaults of the OSRM client's env knobs (env.ts OSRM_TIMEOUT_MS,
 * OSRM_BREAKER_FAILURES, OSRM_BREAKER_COOLDOWN_SECONDS), in one place for env.ts and maps/routing.ts. Kept apart from
 * routing.ts so reading the env never loads the contract.
 */
/** How long one route ask waits for OSRM (the value app.ts hardcoded before B1.3). */
export const OSRM_TIMEOUT_MS_DEFAULT = 2500;
/** Failures in a row that open the breaker (0: breaker off). */
export const OSRM_BREAKER_FAILURES_DEFAULT = 5;
/** How long the open breaker skips OSRM before one probe. */
export const OSRM_BREAKER_COOLDOWN_SECONDS_DEFAULT = 60;
/**
 * Route guard (Rules audits/routing-kit/PROOF.md): OSRM answers "Ok" for a point outside its map by moving it to the
 * nearest road it knows (waypoints[].distance says how far). A point moved further than this makes the answer
 * unusable and the straight-line estimate is used (maps/routing.ts). A point inside the map sits metres to a few tens
 * of metres from its road; a point outside it is moved by kilometres. 300 m is also the scale of the shortest ride
 * the contract allows by default (pricing.minTripMeters). A technical constant of the route client like the timeout
 * above, not a per-country rule.
 */
export const OSRM_MAX_SNAP_METERS_DEFAULT = 300;
