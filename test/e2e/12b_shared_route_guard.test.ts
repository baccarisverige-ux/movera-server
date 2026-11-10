import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Sim } from "./harness.js";
import { contractOps, serverRoutes } from "./routeMatrix.js";
import { missingRows, SHARED_ROWS, sharedServedRoutes } from "./sharedRouteRows.js";

/**
 * T11 (global plan step 66) guard: the shared-route list comes from Fastify's own route tree (printRoutes) and the
 * contract's x-actor, never from a hand list. A new route the contract gives to more than one actor fails here until
 * it gets a row in SHARED_ROWS (test/e2e/sharedRouteRows.ts), so 12c_shared_route_matrix calls it with every caller.
 */

let sim: Sim;
beforeAll(async () => {
  sim = await Sim.start();
});
afterAll(async () => {
  await sim?.stop();
});

describe("T11 guard: every shared route has a matrix row", () => {
  it("each shared route the server serves has a row, and no row names a route nobody serves", () => {
    const served = serverRoutes(sim);
    const shared = sharedServedRoutes(served, contractOps());
    expect(shared.length).toBeGreaterThan(30);
    expect(missingRows(shared, SHARED_ROWS, served)).toEqual({ withoutRow: [], staleRows: [] });
  });

  it("proof: a new shared route without a row is caught", () => {
    const served = [...serverRoutes(sim), "GET /trips/:tripId/matrix-probe"];
    const ops = contractOps({ "GET /trips/:tripId/matrix-probe": { actors: ["rider", "driver", "admin"] } });
    expect(missingRows(sharedServedRoutes(served, ops), SHARED_ROWS, served).withoutRow).toEqual(["GET /trips/:tripId/matrix-probe"]);
  });
});
