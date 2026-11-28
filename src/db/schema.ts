/**
 * Kysely table types for migrations/*.sql, one file per domain under schema/ (global-plan step 57, Rule 25).
 * This barrel keeps every existing `db/schema.js` import working unchanged.
 */
export * from "./schema/riders.js";
export * from "./schema/drivers.js";
export * from "./schema/fleets.js";
export * from "./schema/documents.js";
export * from "./schema/telemetry.js";
export * from "./schema/trips.js";
export * from "./schema/auth.js";
export * from "./schema/admin.js";
export * from "./schema/pricing.js";
export * from "./schema/dispatch.js";
export * from "./schema/payments.js";
export * from "./schema/bonuses.js";
export * from "./schema/support.js";
export * from "./schema/areas.js";
export * from "./schema/database.js";
