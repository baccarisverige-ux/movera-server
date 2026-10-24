import { z } from "zod";

/**
 * Server settings, read from the environment once at start. Anything missing or malformed stops the server
 * before it listens, with the variable named, so a bad deploy never half-starts.
 */
const schema = z.object({
  /**
   * development (laptop), staging (the test week), production (public). Test sign-in numbers exist only outside
   * production, so a deploy that forgets this setting is production: the safe side.
   */
  MOVERA_ENV: z.enum(["development", "staging", "production"]).default("production"),
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
  /** Signs access tokens. At least 32 characters; required on staging and production (a laptop gets a random one). */
  JWT_SECRET: z.string().min(32).optional(),
  /**
   * How many proxies sit in front of the server (the host's load balancer = 1). The client address is read from
   * X-Forwarded-For only that many hops deep, so a phone cannot fake its address. 0: no proxy.
   */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
}).superRefine((env, ctx) => {
  if (env.MOVERA_ENV !== "development" && env.DATABASE_URL === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["DATABASE_URL"], message: `required when MOVERA_ENV is ${env.MOVERA_ENV}` });
  }
  if (env.MOVERA_ENV !== "development" && env.JWT_SECRET === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["JWT_SECRET"], message: `required when MOVERA_ENV is ${env.MOVERA_ENV}` });
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
