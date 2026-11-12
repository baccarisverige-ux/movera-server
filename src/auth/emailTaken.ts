import { sql } from "kysely";
import type { Executor } from "../db/db.js";

/** G30 (emailVerified.unique): the lower-cased address is VERIFIED on another account of the same app (index 0100). */
export async function emailTakenByOther(ex: Executor, actor: "rider" | "driver", subjectId: string, email: string): Promise<boolean> {
  const row = await ex
    .selectFrom((actor === "rider" ? "riders" : "drivers") as "drivers")
    .select((actor === "rider" ? "rider_id" : "driver_id") as "driver_id")
    .where(sql<string>`lower(email)`, "=", email.toLowerCase())
    .where("email_verified_at", "is not", null)
    .where((actor === "rider" ? "rider_id" : "driver_id") as "driver_id", "!=", subjectId)
    .executeTakeFirst();
  return row !== undefined;
}
