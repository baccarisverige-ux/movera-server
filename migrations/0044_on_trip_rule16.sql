-- v0.18.9 owner rule 16 (2026-11-01, the four G7 open questions as admin settings; contract.json#onTrip).
-- Safe to run twice.
-- A case an admin opens from a trip may be shown to the person (default: internal).
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS visible_to_person boolean NOT NULL DEFAULT false;
-- A route price that takes a fixed-price trip to the normal price (routeChange.fixedPriceTrips = switch_to_normal).
ALTER TABLE route_quotes ADD COLUMN IF NOT EXISTS leaves_fixed_price boolean NOT NULL DEFAULT false;
