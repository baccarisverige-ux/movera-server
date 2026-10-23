import { z } from "zod";

/**
 * Server settings, read from the environment once at start. Anything missing or malformed stops the server
 * before it listens, with the variable named, so a bad deploy never half-starts.
 */
const schema = z.object({
  /** development (laptop), staging (the test week), production (public). Test sign-in numbers exist only outside production. */
  MOVERA_ENV: z.enum(["development", "staging", "production"]).default("development"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  /** postgres://user:pass@host:5432/db. Required on staging and production; a laptop may run without one. */
  DATABASE_URL: z.string().url().optional(),
  /** Apply new migrations when the server starts (safe with several instances: they take turns). */
  MIGRATE_ON_START: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
}).superRefine((env, ctx) => {
  if (env.MOVERA_ENV !== "development" && env.DATABASE_URL === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["DATABASE_URL"], message: `required when MOVERA_ENV is ${env.MOVERA_ENV}` });
  }
});

export type Env = z.infer<typeof schema>;

export function readEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
    throw new Error(`Invalid environment:\n${lines.join("\n")}`);
  }
  return parsed.data;
}
