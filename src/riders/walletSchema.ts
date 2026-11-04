import type { ColumnType } from "kysely";

/**
 * v0.18.28 (migration 0070, fix job 6, owner Q4): one wallet balance per rider and currency. Kept out of db/schema.ts
 * on purpose (Rules rule 25: schema.ts is waiting for its split), added to Database here.
 */
export interface RiderWalletsTable {
  rider_id: string;
  currency: string;
  balance_minor: ColumnType<string, number | string | undefined, number | string>;
  updated_at: ColumnType<Date, Date | undefined, Date>;
}

declare module "../db/schema.js" {
  interface Database {
    rider_wallets: RiderWalletsTable;
  }
}
