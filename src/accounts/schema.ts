import type { ColumnType } from "kysely";

/**
 * v0.18.26 (migration 0069, contract.json#phoneDataToServer): the phone-data tables. Kept out of db/schema.ts on
 * purpose (Rules rule 25: schema.ts waits for its split; owner asked first), added to Database here.
 */
type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;

export interface RiderPlacesTable {
  place_id: string;
  rider_id: string;
  kind: "home" | "work" | "other";
  type: string | null;
  label: string;
  address: string;
  lat: number | null;
  lng: number | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface DriverPhoneDataTable {
  driver_id: string;
  categories_off: ColumnType<string[], string[] | undefined, string[]>;
  preferences_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
  emergency_contacts: ColumnType<unknown, string | undefined, string>;
  contacts_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
}

declare module "../db/schema.js" {
  interface Database {
    rider_places: RiderPlacesTable;
    rider_places_imported: { rider_id: string; imported_at: Timestamp };
    driver_phone_data: DriverPhoneDataTable;
  }
}
