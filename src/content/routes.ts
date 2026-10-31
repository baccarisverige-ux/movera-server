import type { FastifyInstance, FastifyRequest } from "fastify";
import { sql } from "kysely";
import { z } from "zod";
import { adminCoversZone, authenticate, authenticateAdmin, type Principal } from "../auth/guard.js";
import type { Db, Executor, Trx } from "../db/db.js";
import { ApiError, badRequest } from "../http/errors.js";
import { API_PREFIX } from "../http/prefix.js";
import { runIdempotent } from "../http/idempotency.js";
import { parseBody } from "../http/validate.js";
import { audit } from "../admin/audit.js";
import { contract } from "../contract/contract.js";
import { CONFIG_CHANNEL, getZone } from "../config/service.js";
import { unacceptedLegalCountries } from "../legal/service.js";

/**
 * Contract v0.10.0 §19 (owner Content answers 2026-10-28, contract.json#content): the admin's Content page publishes
 * texts per place and zone (one admin, audited, history and rollback), the apps read their places, and a legal item
 * published with reaccept blocks booking (rider) and going online (driver) until it is accepted.
 */

export type ContentDeps = { db: Db; jwtSecret: string; defaultZoneId: string; clock?: () => Date };

type App = "rider" | "driver" | "both";
const CONTENT = (contract as unknown as { content: { slots: string[]; apps: Record<string, App> } }).content;
export const CONTENT_SLOTS: readonly string[] = CONTENT.slots;
const LEGAL = "legal";
const APP_VERSIONS = "app-versions";

const ZONE = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const SLOT = z.enum(CONTENT.slots as [string, ...string[]]);
const Timestamp = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/);
const Text = z.string().trim().min(1).max(4000);
const SEMVER = z.string().regex(/^\d+\.\d+\.\d+$/);
const Pair = z.object({ min: SEMVER, recommended: SEMVER });
const PublishBody = z.object({
  zoneIds: z.array(ZONE).min(1).max(200),
  title: z.string().trim().min(1).max(200),
  text: z.object({ sv: Text, fr: Text, en: Text }),
  image: z.string().max(2000).regex(/^https:\/\/\S+$/).optional(),
  expiresAt: Timestamp.optional(),
  reaccept: z.boolean().optional(),
  versions: z.object({ rider: Pair, driver: Pair }).optional(),
});
const RollbackBody = z.object({ zoneId: ZONE, version: z.number().int().min(1) });
const AcceptBody = z.object({ contentVersion: z.number().int().min(1) });

type Row = {
  slot: string;
  zone_id: string;
  version: number;
  title: string;
  text: Record<string, string>;
  image: string | null;
  expires_at: Date | null;
  reaccept: boolean | null;
  versions: unknown;
  published_at: Date;
  published_by: string;
};

export function contentView(row: Row) {
  return {
    slot: row.slot,
    zoneId: row.zone_id,
    version: row.version,
    publishedAt: row.published_at.toISOString(),
    publishedBy: row.published_by,
    title: row.title,
    text: { sv: row.text["sv"] ?? "", fr: row.text["fr"] ?? "", en: row.text["en"] ?? "" },
    ...(row.image ? { image: row.image } : {}),
    ...(row.expires_at ? { expiresAt: row.expires_at.toISOString() } : {}),
    ...(row.reaccept !== null ? { reaccept: row.reaccept } : {}),
    ...(row.versions ? { versions: row.versions } : {}),
  };
}

const semver = (v: string) => v.split(".").map(Number) as [number, number, number];
function atLeast(a: string, b: string): boolean {
  const [x, y] = [semver(a), semver(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! > y[i]!;
  return true;
}

/** The live (highest) version of every place in a zone. */
async function liveItems(ex: Executor, zoneId: string): Promise<Row[]> {
  const rows = (await ex.selectFrom("content_items").selectAll().where("zone_id", "=", zoneId).orderBy("slot").orderBy("version", "desc").execute()) as unknown as Row[];
  const seen = new Set<string>();
  return rows.filter((r) => (seen.has(r.slot) ? false : (seen.add(r.slot), true)));
}

async function latest(ex: Executor, slot: string, zoneId: string): Promise<Row | undefined> {
  return (await ex.selectFrom("content_items").selectAll().where("slot", "=", slot).where("zone_id", "=", zoneId).orderBy("version", "desc").executeTakeFirst()) as unknown as Row | undefined;
}

type Fields = Omit<Row, "slot" | "zone_id" | "version" | "published_at" | "published_by">;

/** Writes the next version of a place in a zone and sends config_published (doc content) on commit. */
async function writeVersion(trx: Trx, slot: string, zoneId: string, fields: Fields, by: string, now: Date, restoredFrom: number | null): Promise<Row> {
  // One writer per place and zone at a time: the advisory lock serializes the version numbers.
  await sql`SELECT pg_advisory_xact_lock(hashtext(${`content:${slot}:${zoneId}`}))`.execute(trx);
  const version = ((await latest(trx, slot, zoneId))?.version ?? 0) + 1;
  await trx
    .insertInto("content_items")
    .values({
      slot,
      zone_id: zoneId,
      version,
      title: fields.title,
      text: JSON.stringify(fields.text),
      image: fields.image,
      expires_at: fields.expires_at,
      reaccept: fields.reaccept,
      versions: fields.versions ? JSON.stringify(fields.versions) : null,
      published_at: now,
      published_by: by,
      restored_from: restoredFrom,
    })
    .execute();
  await sql`SELECT pg_notify(${CONFIG_CHANNEL}, ${JSON.stringify({ doc: "content", zoneId, version, publishedAt: now.toISOString() })})`.execute(trx);
  return (await latest(trx, slot, zoneId))!;
}

/** Zones whose latest legal item asks for re-acceptance that this person has not accepted. */
async function unacceptedZones(ex: Executor, actor: "rider" | "driver", subjectId: string, zoneIds: readonly string[]): Promise<string[]> {
  const out: string[] = [];
  for (const zoneId of new Set(zoneIds)) {
    const legal = await latest(ex, LEGAL, zoneId);
    if (!legal?.reaccept) continue;
    const accepted = await ex.selectFrom("terms_acceptances").select("content_version").where("actor", "=", actor).where("subject_id", "=", subjectId).where("zone_id", "=", zoneId).where("content_version", "=", legal.version).executeTakeFirst();
    if (!accepted) out.push(zoneId);
  }
  return out;
}

/** §19 Legal: until the new terms are accepted the rider cannot book and the driver cannot go online. */
export async function termsAccepted(ex: Executor, actor: "rider" | "driver", subjectId: string, zoneIds: readonly string[]): Promise<boolean> {
  // v0.18.5 (G1-B2): also the country's legal texts (contract.json#legal) when their live version asks for re-acceptance.
  return (await unacceptedZones(ex, actor, subjectId, zoneIds)).length === 0 && (await unacceptedLegalCountries(ex, actor, subjectId, zoneIds)).length === 0;
}

export const TERMS_REASON = "terms_not_accepted";

const keyOf = (request: FastifyRequest) => {
  const value = request.headers["idempotency-key"];
  return Array.isArray(value) ? value[0] : value;
};

function checkZone(who: Principal, zoneId: string): void {
  if (!adminCoversZone(who, zoneId)) throw new ApiError("forbidden", "This zone is outside your scope.", { reason: "zone_out_of_scope" });
}

function validate(slot: string, body: z.infer<typeof PublishBody>, now: Date): void {
  if (body.expiresAt !== undefined && new Date(body.expiresAt).getTime() <= now.getTime()) throw badRequest("expiresAt must be in the future.", "expires_in_past");
  if (body.reaccept !== undefined && slot !== LEGAL) throw badRequest("reaccept is for the legal place only.", "reaccept_not_legal");
  if (body.versions !== undefined && slot !== APP_VERSIONS) throw badRequest("versions are for the app-versions place only.", "versions_not_app_versions");
  if (slot === APP_VERSIONS && body.versions === undefined) throw badRequest("Give the rider and driver app versions.", "versions_required");
  if (body.versions) {
    for (const app of ["rider", "driver"] as const) {
      const pair = body.versions[app];
      if (!atLeast(pair.recommended, pair.min)) throw badRequest(`${app}: the recommended version must be at least the minimum.`, "recommended_below_min");
    }
  }
}

export async function contentRoutes(app: FastifyInstance, deps: ContentDeps): Promise<void> {
  const guard = { db: deps.db, jwtSecret: deps.jwtSecret, ...(deps.clock ? { clock: deps.clock } : {}) };
  const now = () => deps.clock?.() ?? new Date();
  const idem = (request: FastifyRequest, who: Principal, body: unknown) => ({ actor: who.actor, subjectId: who.subjectId, key: keyOf(request), method: request.method, route: request.url.split("?")[0]!, body });
  const slotParam = (request: FastifyRequest) => parseBody(z.object({ slot: SLOT }), request.params).slot;
  const zoneQuery = (request: FastifyRequest) => parseBody(z.object({ zoneId: ZONE }), request.query).zoneId;

  app.get(`${API_PREFIX}/admin/content`, async (request) => {
    const who = await authenticateAdmin(request, guard, "settings.read");
    const zoneId = zoneQuery(request);
    checkZone(who, zoneId);
    await getZone(deps.db, zoneId);
    return { items: (await liveItems(deps.db, zoneId)).map(contentView) };
  });

  app.get(`${API_PREFIX}/admin/content/legal/acceptances`, async (request) => {
    const who = await authenticateAdmin(request, guard, "settings.read");
    const zoneId = zoneQuery(request);
    checkZone(who, zoneId);
    await getZone(deps.db, zoneId);
    const rows = await deps.db.selectFrom("terms_acceptances").selectAll().where("zone_id", "=", zoneId).orderBy("accepted_at", "desc").limit(1000).execute();
    return { items: rows.map((r) => ({ actor: r.actor, subjectId: r.subject_id, zoneId: r.zone_id, contentVersion: r.content_version, acceptedAt: r.accepted_at.toISOString() })) };
  });

  app.get(`${API_PREFIX}/admin/content/:slot/history`, async (request) => {
    const who = await authenticateAdmin(request, guard, "settings.read");
    const slot = slotParam(request);
    const zoneId = zoneQuery(request);
    checkZone(who, zoneId);
    await getZone(deps.db, zoneId);
    const rows = (await deps.db.selectFrom("content_items").selectAll().where("slot", "=", slot).where("zone_id", "=", zoneId).orderBy("version", "desc").execute()) as unknown as Row[];
    return { items: rows.map(contentView) };
  });

  // One admin is enough (no second admin); the publish goes only to the chosen zones, each of them in scope.
  app.post(`${API_PREFIX}/admin/content/:slot/publish`, async (request) => {
    const who = await authenticateAdmin(request, guard, "settings.publish");
    const slot = slotParam(request);
    const body = parseBody(PublishBody, request.body);
    const zoneIds = [...new Set(body.zoneIds)];
    for (const zoneId of zoneIds) checkZone(who, zoneId);
    validate(slot, body, now());
    const outcome = await runIdempotent(deps.db, idem(request, who, body), async (trx) => {
      const items: Row[] = [];
      for (const zoneId of zoneIds) {
        await getZone(trx, zoneId);
        const fields: Fields = { title: body.title, text: body.text, image: body.image ?? null, expires_at: body.expiresAt ? new Date(body.expiresAt) : null, reaccept: body.reaccept ?? null, versions: body.versions ?? null };
        items.push(await writeVersion(trx, slot, zoneId, fields, who.subjectId, now(), null));
      }
      await audit(trx, { adminId: who.subjectId, action: "content.publish", targetType: "content", targetId: slot, zoneId: zoneIds.length === 1 ? zoneIds[0]! : null, detail: { zones: items.map((i) => ({ zoneId: i.zone_id, version: i.version })), title: body.title, ...(body.reaccept ? { reaccept: true } : {}) }, at: now() });
      return { status: 200, body: { items: items.map(contentView) } };
    });
    return outcome.body;
  });

  // Rollback: the earlier version again, as the next version.
  app.post(`${API_PREFIX}/admin/content/:slot/rollback`, async (request) => {
    const who = await authenticateAdmin(request, guard, "settings.publish");
    const slot = slotParam(request);
    const body = parseBody(RollbackBody, request.body);
    checkZone(who, body.zoneId);
    const outcome = await runIdempotent(deps.db, idem(request, who, body), async (trx) => {
      await getZone(trx, body.zoneId);
      const old = (await trx.selectFrom("content_items").selectAll().where("slot", "=", slot).where("zone_id", "=", body.zoneId).where("version", "=", body.version).executeTakeFirst()) as unknown as Row | undefined;
      if (!old) throw new ApiError("not_found", "No such version.", { reason: "content_version_not_found" });
      const row = await writeVersion(trx, slot, body.zoneId, { title: old.title, text: old.text, image: old.image, expires_at: old.expires_at, reaccept: old.reaccept, versions: old.versions }, who.subjectId, now(), old.version);
      await audit(trx, { adminId: who.subjectId, action: "content.rollback", targetType: "content", targetId: slot, zoneId: body.zoneId, detail: { restoredFrom: old.version, version: row.version }, at: now() });
      return { status: 200, body: contentView(row) };
    });
    return outcome.body;
  });

  for (const actor of ["rider", "driver"] as const) {
    app.get(`${API_PREFIX}/${actor}/content`, async (request) => {
      await authenticate(request, guard, [actor]);
      const zoneId = parseBody(z.object({ zoneId: ZONE.optional() }), request.query).zoneId ?? deps.defaultZoneId;
      await getZone(deps.db, zoneId);
      const at = now().getTime();
      const items = (await liveItems(deps.db, zoneId)).filter((r) => {
        const owner = CONTENT.apps[r.slot];
        return (owner === actor || owner === "both") && (r.expires_at === null || r.expires_at.getTime() > at);
      });
      return { items: items.map(contentView) };
    });
  }

  // Accepts the given legal version in every zone where it is the live legal item.
  app.post(`${API_PREFIX}/account/terms/accept`, async (request, reply) => {
    const who = await authenticate(request, guard, ["rider", "driver"]);
    const body = parseBody(AcceptBody, request.body);
    await runIdempotent(deps.db, idem(request, who, body), async (trx) => {
      const rows = (await trx.selectFrom("content_items").select(["zone_id", "version"]).where("slot", "=", LEGAL).where("version", "=", body.contentVersion).execute()) as Array<{ zone_id: string; version: number }>;
      const zones: string[] = [];
      for (const r of rows) if ((await latest(trx, LEGAL, r.zone_id))?.version === r.version) zones.push(r.zone_id);
      if (zones.length === 0) throw new ApiError("conflict", "These are not the current terms; open the app again.", { reason: "terms_version_not_current" });
      await trx
        .insertInto("terms_acceptances")
        .values(zones.map((zoneId) => ({ actor: who.actor as "rider" | "driver", subject_id: who.subjectId, zone_id: zoneId, content_version: body.contentVersion, accepted_at: now() })))
        .onConflict((oc) => oc.doNothing())
        .execute();
      return { status: 204, body: null };
    });
    return reply.status(204).send();
  });
}
