import type { ColumnType } from "kysely";

/** Kysely table types for migrations/*.sql. Keep in step with every migration. */

export type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
export type Json<T = unknown> = ColumnType<T, string | T, string | T>;
/** A json column with a database default: optional on insert. */
export type JsonDefault<T = unknown> = ColumnType<T, string | T | undefined, string | T>;
