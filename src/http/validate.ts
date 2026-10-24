import type { z } from "zod";
import { badRequest } from "./errors.js";

/** Reads a request body with a zod schema; a mismatch is 400 invalid_request, reason invalid_body, naming the field. */
export function parseBody<T extends z.ZodTypeAny>(schema: T, body: unknown): z.infer<T> {
  const parsed = schema.safeParse(body ?? {});
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0]!;
  const where = issue.path.length ? issue.path.join(".") : "body";
  throw badRequest(`${where}: ${issue.message}`, "invalid_body");
}
