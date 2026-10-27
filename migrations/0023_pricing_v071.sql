-- Contract v0.7.1, pricing rework part 2 (owner Pricing decisions 2026-10-27).

-- One seat fee (childSeatFee on child_seat only) and no free minutes at a stop: the old keys leave the
-- pricing drafts and live documents (history keeps what was published).
UPDATE config_drafts d SET document = (
  SELECT jsonb_set(d.document - 'stopFreeWaitMin', '{categories}', COALESCE(jsonb_object_agg(k, (v - 'babySeatFee') - CASE WHEN k = 'child_seat' THEN '' ELSE 'childSeatFee' END), '{}'::jsonb))
  FROM jsonb_each(d.document -> 'categories') AS c(k, v)
) WHERE d.doc = 'pricing' AND d.document ? 'categories';
UPDATE config_live l SET document = (
  SELECT jsonb_set(l.document - 'stopFreeWaitMin', '{categories}', COALESCE(jsonb_object_agg(k, (v - 'babySeatFee') - CASE WHEN k = 'child_seat' THEN '' ELSE 'childSeatFee' END), '{}'::jsonb))
  FROM jsonb_each(l.document -> 'categories') AS c(k, v)
) WHERE l.doc = 'pricing' AND l.document ? 'categories';

-- Waiting at a middle stop: the driver's arrived-at-stop / leaving-stop taps (contract.json#stopWaits).
ALTER TABLE trips ADD COLUMN stop_visits jsonb NOT NULL DEFAULT '[]'::jsonb;

-- Restore / Undo last publish (contract.json#pricingHistory).
ALTER TABLE config_history ADD COLUMN action text NOT NULL DEFAULT 'publish' CHECK (action IN ('publish', 'restore'));
ALTER TABLE config_history ADD COLUMN restored_from integer;

-- The zone's surge schedule: the admin's manual Start / Stop (PUT /admin/zones/{zoneId}/surge, §3.4).
CREATE TABLE surge_schedules (
  schedule_id  text PRIMARY KEY,
  zone_id      text NOT NULL REFERENCES zones (zone_id),
  category_ids text[] NOT NULL DEFAULT '{}',
  start_at     timestamptz NOT NULL,
  end_at       timestamptz NOT NULL,
  step_minutes integer NOT NULL CHECK (step_minutes >= 1),
  cap          numeric(4, 2) NOT NULL CHECK (cap >= 1),
  points       jsonb NOT NULL,
  status       text NOT NULL CHECK (status IN ('scheduled', 'active', 'ended', 'cancelled')),
  version      integer NOT NULL CHECK (version >= 1),
  created_by   text NOT NULL,
  created_at   timestamptz NOT NULL,
  ended_at     timestamptz
);
CREATE INDEX surge_schedules_zone ON surge_schedules (zone_id, created_at DESC);

-- Smart surge, one row per zone (contract.json#smartSurge).
CREATE TABLE smart_surge_state (
  zone_id      text PRIMARY KEY REFERENCES zones (zone_id),
  multiplier   numeric(4, 2) NOT NULL DEFAULT 1,
  up_since     timestamptz,
  low_since    timestamptz,
  last_change  timestamptz,
  checked_at   timestamptz,
  ratio        numeric(8, 3) NOT NULL DEFAULT 0,
  profile_id   text
);

-- The car type catalog for every country and zone (contract.json#categoryCatalog).
CREATE TABLE categories (
  category_id    text PRIMARY KEY CHECK (category_id ~ '^[a-z][a-z0-9_]{1,31}$'),
  label          text NOT NULL,
  line           jsonb NOT NULL DEFAULT '{}'::jsonb,
  seats          integer NOT NULL CHECK (seats BETWEEN 1 AND 8),
  built_in       boolean NOT NULL DEFAULT false,
  sort           integer NOT NULL DEFAULT 0,
  archived_at    timestamptz,
  archived_by    text,
  archive_reason text,
  updated_at     timestamptz NOT NULL DEFAULT now()
);
INSERT INTO categories (category_id, label, line, seats, built_in, sort) VALUES
  ('economy', 'Movera', '{"sv": "Vardagsresa", "fr": "Course du quotidien", "en": "Everyday ride"}', 4, true, 0),
  ('comfort', 'Comfort', '{"sv": "Nyare bilar, mer plats", "fr": "Voitures récentes, plus d’espace", "en": "Newer cars, more room"}', 4, true, 1),
  ('premium', 'Premium', '{"sv": "Exklusiva bilar, toppförare", "fr": "Voitures haut de gamme, meilleurs chauffeurs", "en": "High-end cars, top drivers"}', 4, true, 2),
  ('priority', 'Priority', '{"sv": "Snabbare upphämtning", "fr": "Prise en charge plus rapide", "en": "Faster pickup"}', 4, true, 3),
  ('xl', 'Movera XL', '{"sv": "Upp till 6 platser", "fr": "Jusqu’à 6 places", "en": "Up to 6 seats"}', 6, true, 4),
  ('electric', 'Electric', '{"sv": "Helt eldriven bil", "fr": "Voiture 100 % électrique", "en": "Fully electric car"}', 4, true, 5),
  ('pet', 'Movera Pet', '{"sv": "Ditt husdjur åker med dig", "fr": "Votre animal voyage avec vous", "en": "Your pet rides with you"}', 4, true, 6),
  ('child_seat', 'Child Seat', '{"sv": "Bil med babystol eller barnstol", "fr": "Voiture avec siège bébé ou enfant", "en": "Car with a baby or child seat"}', 4, true, 7);
