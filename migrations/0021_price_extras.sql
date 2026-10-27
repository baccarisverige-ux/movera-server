-- Contract v0.6.0 (§3.5, contract.json#pricing.requestExtras): what the rider asked for that the price depends on
-- (babySeats, childSeats, airportPickup, airportDropoff, fixedRouteId). The quote keeps it, the trip copies it and
-- the fare at completion prices it again.
ALTER TABLE quotes ADD COLUMN price_extras jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE trips ADD COLUMN price_extras jsonb NOT NULL DEFAULT '{}'::jsonb;
