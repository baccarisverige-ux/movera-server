import { cpSync, mkdtempSync, appendFileSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MIGRATIONS_DIR, migrate } from "../../src/db/migrate.js";
import { createPool } from "../../src/db/db.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { insertDriver, insertRider, insertTrip } from "../support/seed.js";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function emptyDb(): Promise<TestDatabase> {
  const database = await freshDatabase({ migrated: false });
  cleanups.push(database.drop);
  return database;
}

function copyOfMigrations(): string {
  const dir = mkdtempSync(join(tmpdir(), "movera-migrations-"));
  cpSync(MIGRATIONS_DIR, dir, { recursive: true });
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function tables(database: TestDatabase): Promise<string[]> {
  const result = await database.pool.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename");
  return result.rows.map((row) => row.tablename);
}

describe("migrate", () => {
  it("applies every migration once; a second run applies nothing", async () => {
    const database = await emptyDb();
    expect(await migrate(database.pool)).toEqual(["0001_foundation.sql", "0002_auth.sql", "0003_admin.sql", "0004_config.sql", "0005_quotes.sql", "0006_trips.sql", "0007_drivers.sql", "0008_dispatch.sql", "0009_ride.sql", "0010_admin.sql", "0011_onboarding.sql", "0012_invitations.sql", "0013_trip_messages.sql", "0014_zones_stockholm_paris.sql", "0015_stockholm_south.sql", "0016_driver_silent_alert.sql", "0017_paris_ile_de_france.sql", "0018_document_upload_attempts.sql", "0019_telemetry.sql", "0020_earnings_trip_index.sql", "0021_incidents.sql", "0021_price_extras.sql", "0022_settings_flow.sql", "0023_pricing_v071.sql", "0024_surge_samples.sql", "0025_realdata.sql", "0026_content.sql", "0027_kpi_money.sql", "0028_zones.sql", "0029_ride_checks.sql", "0030_chat.sql", "0031_sign_in_waitlist.sql", "0032_error_groups.sql", "0033_onboarding_settings.sql", "0034_complete_previews.sql", "0035_car_base_year.sql", "0036_push_sent.sql", "0037_driver_home.sql", "0038_deep_fixes.sql", "0039_driver_offers.sql", "0040_dispatch_tools.sql", "0041_pickup_waiting.sql", "0042_arrived_waiting.sql", "0043_on_trip.sql", "0044_on_trip_rule16.sql", "0045_finish.sql", "0046_driver_bonus_scope.sql", "0047_kpi_movera_earnings.sql", "0048_live_cleanup.sql", "0049_deep_fix_1.sql", "0050_support_desk.sql", "0051_book_later.sql", "0063_admin_first_name.sql", "0064_book_later_owner_defaults.sql", "0065_reservation_policy.sql", "0066_server_alerts.sql", "0067_admin_live_events.sql", "0068_server_alerts_live_events.sql", "0069_phone_data_to_server.sql", "0070_rider_wallets_per_currency.sql", "0073_alerts_old_list.sql", "0079_rider_moderation.sql", "0080_payout_hold.sql", "0081_payout_mode.sql", "0082_trip_next_after.sql", "0084_offline_after_trip.sql", "0085_trip_calls.sql", "0086_airport_queue.sql", "0087_blocked_pairs.sql", "0088_french_texts.sql", "0089_refresh_lost_answer.sql", "0090_chat_g9_part2.sql", "0091_pool_hot_indexes.sql", "0092_trip_gap_roads.sql", "0093_admin_slow_queries.sql", "0094_offer_push_purge_index.sql", "0095_kpis_trip_indexes.sql", "0096_rider_wallets_balance_nonneg.sql", "0097_chat_auto_translate.sql", "0098_next_trips_off.sql", "0099_email_verified.sql", "0100_email_lower_indexes.sql", "0101_debt_kinds.sql", "0102_wallet_floor.sql", "0103_fees_into_wallet.sql", "0105_incidents_person_indexes.sql", "0107_lost_driver_paid.sql", "0108_earnings_payout_index.sql", "0109_payout_paid_summary.sql", "0110_bonus_campaigns.sql", "0111_incidents_contacts_sms.sql", "0112_support_waiting_since.sql", "0113_alerts_live_solved_recent.sql"]);
    expect(await migrate(database.pool)).toEqual([]);
    expect(await tables(database)).toEqual(
      ["account_change_starts", "admin_alert_book", "admin_alert_quiet", "admin_alert_records", "admin_alert_rule_state", "admin_alerts_live", "admin_audit", "admin_incident_settings", "admin_live_events", "admin_live_pruned", "admin_setup_links", "admin_sign_in_failures", "admin_trip_notes", "admins", "airport_queue_areas", "airport_queue_entries", "approvals", "area_events", "auth_link_tokens", "auth_provider_links", "auth_sessions", "blocked_pairs", "bonus_campaigns", "bonus_progress", "bonus_rider_days", "bonus_trips_counted", "categories", "complete_previews", "config_drafts", "config_history", "config_live", "content_items", "dispatch_controls", "dispatch_events", "dispatch_presets", "document_files", "document_notices", "document_renewals", "document_upload_attempts", "documents", "driver_cancels", "driver_groups", "driver_locations", "driver_phone_data", "drivers", "earnings_entries", "email_changes", "error_group_devices", "error_groups", "fleet_invitations", "fleet_join_attempts", "fleets", "idempotency_keys", "incident_events", "incidents", "kpi_days", "legal_acceptances", "legal_texts", "notifications", "offer_events", "offers", "otp_sessions", "outbound_notices", "payouts", "push_devices", "quotes", "radar_zone_rules", "radar_zone_sends", "radar_zones", "ratings", "refresh_tokens", "refunds", "reservation_policy", "review_people", "review_rules", "ride_checks", "rider_favourite_drivers", "rider_fees", "rider_phone_data", "rider_places", "rider_places_imported", "rider_wallets", "riders", "route_quotes", "schema_migrations", "searches", "sign_in_waitlist", "sign_in_waitlist_asks", "sign_up_reminders", "smart_surge_state", "sms_outbox", "support_settings", "support_tickets", "surge_samples", "surge_schedules", "telemetry", "terms_acceptances", "test_phones", "ticket_messages", "timers", "trip_calls", "trip_events", "trip_gap_roads", "trip_locations", "trip_message_translations", "trip_messages", "trip_stream_presence", "trips", "vehicles", "wallet_entries", "wallet_floors", "zones"],
    );
  });

  it("0095: the KPI trip indexes are built and valid", async () => {
    const database = await freshDatabase();
    cleanups.push(database.drop);
    const indexes = await database.pool.query<{ name: string; valid: boolean }>(
      "SELECT c.relname AS name, i.indisvalid AS valid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname IN ('trips_zone_ended', 'trips_zone_created') ORDER BY 1");
    expect(indexes.rows).toEqual([{ name: "trips_zone_created", valid: true }, { name: "trips_zone_ended", valid: true }]);
  });

  it("two servers starting together apply it once (advisory lock)", async () => {
    const database = await emptyDb();
    const other = createPool(database.url, 2);
    cleanups.push(() => other.end());
    const [a, b] = await Promise.all([migrate(database.pool), migrate(other)]);
    expect([...a, ...b].sort()).toEqual(["0001_foundation.sql", "0002_auth.sql", "0003_admin.sql", "0004_config.sql", "0005_quotes.sql", "0006_trips.sql", "0007_drivers.sql", "0008_dispatch.sql", "0009_ride.sql", "0010_admin.sql", "0011_onboarding.sql", "0012_invitations.sql", "0013_trip_messages.sql", "0014_zones_stockholm_paris.sql", "0015_stockholm_south.sql", "0016_driver_silent_alert.sql", "0017_paris_ile_de_france.sql", "0018_document_upload_attempts.sql", "0019_telemetry.sql", "0020_earnings_trip_index.sql", "0021_incidents.sql", "0021_price_extras.sql", "0022_settings_flow.sql", "0023_pricing_v071.sql", "0024_surge_samples.sql", "0025_realdata.sql", "0026_content.sql", "0027_kpi_money.sql", "0028_zones.sql", "0029_ride_checks.sql", "0030_chat.sql", "0031_sign_in_waitlist.sql", "0032_error_groups.sql", "0033_onboarding_settings.sql", "0034_complete_previews.sql", "0035_car_base_year.sql", "0036_push_sent.sql", "0037_driver_home.sql", "0038_deep_fixes.sql", "0039_driver_offers.sql", "0040_dispatch_tools.sql", "0041_pickup_waiting.sql", "0042_arrived_waiting.sql", "0043_on_trip.sql", "0044_on_trip_rule16.sql", "0045_finish.sql", "0046_driver_bonus_scope.sql", "0047_kpi_movera_earnings.sql", "0048_live_cleanup.sql", "0049_deep_fix_1.sql", "0050_support_desk.sql", "0051_book_later.sql", "0063_admin_first_name.sql", "0064_book_later_owner_defaults.sql", "0065_reservation_policy.sql", "0066_server_alerts.sql", "0067_admin_live_events.sql", "0068_server_alerts_live_events.sql", "0069_phone_data_to_server.sql", "0070_rider_wallets_per_currency.sql", "0073_alerts_old_list.sql", "0079_rider_moderation.sql", "0080_payout_hold.sql", "0081_payout_mode.sql", "0082_trip_next_after.sql", "0084_offline_after_trip.sql", "0085_trip_calls.sql", "0086_airport_queue.sql", "0087_blocked_pairs.sql", "0088_french_texts.sql", "0089_refresh_lost_answer.sql", "0090_chat_g9_part2.sql", "0091_pool_hot_indexes.sql", "0092_trip_gap_roads.sql", "0093_admin_slow_queries.sql", "0094_offer_push_purge_index.sql", "0095_kpis_trip_indexes.sql", "0096_rider_wallets_balance_nonneg.sql", "0097_chat_auto_translate.sql", "0098_next_trips_off.sql", "0099_email_verified.sql", "0100_email_lower_indexes.sql", "0101_debt_kinds.sql", "0102_wallet_floor.sql", "0103_fees_into_wallet.sql", "0105_incidents_person_indexes.sql", "0107_lost_driver_paid.sql", "0108_earnings_payout_index.sql", "0109_payout_paid_summary.sql", "0110_bonus_campaigns.sql", "0111_incidents_contacts_sms.sql", "0112_support_waiting_since.sql", "0113_alerts_live_solved_recent.sql"]);
  });

  it("refuses to start when an applied migration was edited", async () => {
    const database = await emptyDb();
    const dir = copyOfMigrations();
    await migrate(database.pool, dir);
    appendFileSync(join(dir, "0001_foundation.sql"), "\n-- edited later\n");
    await expect(migrate(database.pool, dir)).rejects.toThrow(/0001_foundation\.sql changed after it was applied/);
  });

  it("a failing migration leaves nothing half-done", async () => {
    const database = await emptyDb();
    const dir = copyOfMigrations();
    writeFileSync(join(dir, "0099_broken.sql"), "CREATE TABLE half_done (id int);\nSELECT * FROM no_such_table;\n");
    await expect(migrate(database.pool, dir)).rejects.toThrow(/Migration 0099_broken\.sql failed/);
    expect(await tables(database)).not.toContain("half_done");
    const applied = await database.pool.query("SELECT name FROM schema_migrations ORDER BY name");
    expect(applied.rows).toEqual([{ name: "0001_foundation.sql" }, { name: "0002_auth.sql" }, { name: "0003_admin.sql" }, { name: "0004_config.sql" }, { name: "0005_quotes.sql" }, { name: "0006_trips.sql" }, { name: "0007_drivers.sql" }, { name: "0008_dispatch.sql" }, { name: "0009_ride.sql" }, { name: "0010_admin.sql" }, { name: "0011_onboarding.sql" }, { name: "0012_invitations.sql" }, { name: "0013_trip_messages.sql" }, { name: "0014_zones_stockholm_paris.sql" }, { name: "0015_stockholm_south.sql" }, { name: "0016_driver_silent_alert.sql" }, { name: "0017_paris_ile_de_france.sql" }, { name: "0018_document_upload_attempts.sql" }, { name: "0019_telemetry.sql" }, { name: "0020_earnings_trip_index.sql" }, { name: "0021_incidents.sql" }, { name: "0021_price_extras.sql" }, { name: "0022_settings_flow.sql" }, { name: "0023_pricing_v071.sql" }, { name: "0024_surge_samples.sql" }, { name: "0025_realdata.sql" }, { name: "0026_content.sql" }, { name: "0027_kpi_money.sql" }, { name: "0028_zones.sql" }, { name: "0029_ride_checks.sql" }, { name: "0030_chat.sql" }, { name: "0031_sign_in_waitlist.sql" }, { name: "0032_error_groups.sql" }, { name: "0033_onboarding_settings.sql" }, { name: "0034_complete_previews.sql" }, { name: "0035_car_base_year.sql" }, { name: "0036_push_sent.sql" }, { name: "0037_driver_home.sql" }, { name: "0038_deep_fixes.sql" }, { name: "0039_driver_offers.sql" }, { name: "0040_dispatch_tools.sql" }, { name: "0041_pickup_waiting.sql" }, { name: "0042_arrived_waiting.sql" }, { name: "0043_on_trip.sql" }, { name: "0044_on_trip_rule16.sql" }, { name: "0045_finish.sql" }, { name: "0046_driver_bonus_scope.sql" }, { name: "0047_kpi_movera_earnings.sql" }, { name: "0048_live_cleanup.sql" }, { name: "0049_deep_fix_1.sql" }, { name: "0050_support_desk.sql" }, { name: "0051_book_later.sql" }, { name: "0063_admin_first_name.sql" }, { name: "0064_book_later_owner_defaults.sql" }, { name: "0065_reservation_policy.sql" }, { name: "0066_server_alerts.sql" }, { name: "0067_admin_live_events.sql" }, { name: "0068_server_alerts_live_events.sql" }, { name: "0069_phone_data_to_server.sql" }, { name: "0070_rider_wallets_per_currency.sql" }, { name: "0073_alerts_old_list.sql" }, { name: "0079_rider_moderation.sql" }, { name: "0080_payout_hold.sql" }, { name: "0081_payout_mode.sql" }, { name: "0082_trip_next_after.sql" }, { name: "0084_offline_after_trip.sql" }, { name: "0085_trip_calls.sql" }, { name: "0086_airport_queue.sql" }, { name: "0087_blocked_pairs.sql" }, { name: "0088_french_texts.sql" }, { name: "0089_refresh_lost_answer.sql" }, { name: "0090_chat_g9_part2.sql" }, { name: "0091_pool_hot_indexes.sql" }, { name: "0092_trip_gap_roads.sql" }, { name: "0093_admin_slow_queries.sql" }, { name: "0094_offer_push_purge_index.sql" }, { name: "0095_kpis_trip_indexes.sql" }, { name: "0096_rider_wallets_balance_nonneg.sql" }, { name: "0097_chat_auto_translate.sql" }, { name: "0098_next_trips_off.sql" }]);
  });
});

describe("migration 0041 (driver group 5)", () => {
  it("moves the pickup move limit 500 → 200 with version + history, and splits the rider's debt per currency", async () => {
    const database = await emptyDb();
    const dir = copyOfMigrations();
    const file = "0041_pickup_waiting.sql";
    const kept = readFileSync(join(dir, file));
    rmSync(join(dir, file));
    await migrate(database.pool, dir);
    // A 0040-state world: a driver document on 500 (version 3), a draft on 500, and fees owed in two currencies.
    const doc = { version: 3, publishedAt: "2026-10-01T00:00:00.000Z", zoneId: "Z001", booking: { maxStops: 3, maxPickupMoveMeters: 500 } };
    await database.pool.query("INSERT INTO config_live (doc, zone_id, version, document, published_at) VALUES ('driver_app_config', 'Z001', 3, $1, now())", [JSON.stringify(doc)]);
    await database.pool.query("INSERT INTO config_drafts (doc, zone_id, version, document) VALUES ('rider_app_config', 'Z001', 4, $1)", [JSON.stringify({ ...doc, version: 4 })]);
    const riderId = await insertRider(database.db);
    const se = await insertTrip(database.db, riderId, { status: "cancelled_by_rider" });
    const fr = await insertTrip(database.db, riderId, { status: "cancelled_by_rider" });
    await database.pool.query("INSERT INTO rider_fees (trip_id, rider_id, kind, currency, amount_minor, status, created_at) VALUES ($1, $2, 'cancel', 'SEK', 10000, 'owed', '2026-10-01'), ($3, $2, 'cancel', 'EUR', 500, 'owed', '2026-10-02')", [se, riderId, fr]);
    await database.pool.query("UPDATE riders SET outstanding_minor = 10500 WHERE rider_id = $1", [riderId]);
    writeFileSync(join(dir, file), kept);
    expect(await migrate(database.pool, dir)).toEqual([file]);
    const live = (await database.pool.query("SELECT version, document FROM config_live WHERE doc = 'driver_app_config' AND zone_id = 'Z001'")).rows[0];
    expect(live.version).toBe(4);
    expect(live.document.booking.maxPickupMoveMeters).toBe(200);
    expect(live.document.version).toBe(4);
    expect(live.document.publishedAt).toMatch(/^2026-/);
    const history = (await database.pool.query("SELECT version, document, note FROM config_history WHERE doc = 'driver_app_config' AND zone_id = 'Z001'")).rows;
    expect(history).toHaveLength(1);
    expect(history[0].version).toBe(4);
    expect(history[0].document).toEqual(live.document);
    expect(history[0].note).toMatch(/500 -> 200/);
    const draft = (await database.pool.query("SELECT version, document FROM config_drafts WHERE doc = 'rider_app_config'")).rows[0];
    expect(draft.version).toBe(5);
    expect(draft.document.booking.maxPickupMoveMeters).toBe(200);
    const rider = (await database.pool.query("SELECT outstanding_minor, outstanding_currency, outstanding_source_trip_id FROM riders WHERE rider_id = $1", [riderId])).rows[0];
    expect(rider).toEqual({ outstanding_minor: "10000", outstanding_currency: "SEK", outstanding_source_trip_id: se });
    // Running it again changes nothing more.
    expect(await migrate(database.pool, dir)).toEqual([]);
    expect((await database.pool.query("SELECT version FROM config_live WHERE doc = 'driver_app_config'")).rows[0].version).toBe(4);
  });
});

describe("schema rules", () => {
  it("a rider has at most one live trip that is not over", async () => {
    const database = await freshDatabase();
    cleanups.push(database.drop);
    const rider = await insertRider(database.db);
    await insertTrip(database.db, rider, { status: "completed" });
    await insertTrip(database.db, rider, { status: "searching" });
    await insertTrip(database.db, rider, { kind: "scheduled", status: "requested" });
    await expect(insertTrip(database.db, rider, { status: "requested" })).rejects.toThrow(/trips_one_live_per_rider/);
  });

  it("a driver has at most one active trip", async () => {
    const database = await freshDatabase();
    cleanups.push(database.drop);
    const driver = await insertDriver(database.db);
    await insertTrip(database.db, await insertRider(database.db), { status: "in_trip", driverId: driver });
    await expect(
      insertTrip(database.db, await insertRider(database.db), { status: "accepted", driverId: driver }),
    ).rejects.toThrow(/trips_one_active_per_driver/);
  });

  it("statuses outside the contract are refused", async () => {
    const database = await freshDatabase();
    cleanups.push(database.drop);
    await expect(insertTrip(database.db, await insertRider(database.db), { status: "teleporting" })).rejects.toThrow(/check constraint/);
  });
});
