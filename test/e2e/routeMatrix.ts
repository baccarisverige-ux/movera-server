import { readFileSync } from "node:fs";
import { parse } from "yaml";
import type { Json, Sim } from "./harness.js";

/** Who may call one contract operation (`x-actor`, `x-permission`, `security`). Shared by the route matrix tests. */
export type Op = { actors: string[]; permission?: string; public?: boolean; optionalAuth?: boolean };

/** Every contract operation, keyed "METHOD /path/:param" like Fastify; `extra` adds routes the contract does not list. */
export function contractOps(extra: Record<string, Op> = {}): Map<string, Op> {
  const doc = parse(readFileSync(new URL("../../contracts/openapi.yaml", import.meta.url), "utf8")) as Json;
  const ops = new Map<string, Op>();
  for (const [path, methods] of Object.entries(doc["paths"] as Json)) {
    for (const [method, op] of Object.entries(methods as Json)) {
      if (!["get", "post", "put", "patch", "delete"].includes(method)) continue;
      const security = (op as Json)["security"] as Json[] | undefined;
      const key = `${method.toUpperCase()} ${path.replace(/\{(\w+)\}/g, ":$1")}`;
      ops.set(key, {
        actors: (op as Json)["x-actor"] as string[],
        ...((op as Json)["x-permission"] ? { permission: (op as Json)["x-permission"] as string } : {}),
        ...(Array.isArray(security) && security.length === 0 ? { public: true } : {}),
        ...(Array.isArray(security) && security.some((s) => Object.keys(s).length === 0) && security.length > 0 ? { optionalAuth: true } : {}),
      });
    }
  }
  for (const [key, op] of Object.entries(extra)) ops.set(key, op);
  return ops;
}

/** Every method + path Fastify serves under /api/v1, from its route tree. */
export function serverRoutes(sim: Sim): string[] {
  const tree = sim.app.printRoutes({ commonPrefix: false });
  const stack: string[] = [];
  const out: string[] = [];
  for (const line of tree.split("\n")) {
    const m = /^([│ ]*)[├└]── (\S+)(?: \(([^)]*)\))?/.exec(line);
    if (!m) continue;
    const depth = m[1]!.length / 4;
    stack.length = depth;
    stack.push(m[2]!);
    const full = stack.join("");
    for (const method of (m[3] ?? "").split(",").map((s) => s.trim()).filter((s) => s && s !== "HEAD")) {
      if (full.startsWith("/api/v1/")) out.push(`${method} ${full.slice("/api/v1".length)}`);
    }
  }
  return out;
}
