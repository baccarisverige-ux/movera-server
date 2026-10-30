import type { Executor } from "../db/db.js";
import type { DocumentKey } from "../documents/files.js";
import { openFile } from "../documents/files.js";
import { notFound } from "../http/errors.js";
import { API_PREFIX } from "../http/prefix.js";
import { DRIVER_ASSIGNED, type TripStatus } from "../rules/transitions.js";

/**
 * Contract v0.18.5 §30 (owner G2-D3 "Yes, approved photo (Recommended)", contract.json#driverOnboarding.riderDriverPhoto):
 * the rider sees the driver's approved profile photo while the driver comes and during the trip. Only the approved
 * document of type profile_photo counts (never one in review, a renewal, a rejected or an expired one); the file goes
 * through the rider's own trip, never as a public link.
 */
const PHOTO = "profile_photo";

async function approvedPhoto(ex: Executor, driverId: string) {
  return ex
    .selectFrom("documents")
    .select(["document_id", "media_type", "expires_at"])
    .where("owner_kind", "=", "driver")
    .where("owner_id", "=", driverId)
    .where("type", "=", PHOTO)
    .where("status", "=", "approved")
    .executeTakeFirst();
}

/** DriverSummary.photoUrl for a trip, or undefined while the driver has no approved photo. */
export async function driverPhotoUrl(ex: Executor, driverId: string, tripId: string, now: Date = new Date()): Promise<string | undefined> {
  const photo = await approvedPhoto(ex, driverId);
  if (photo === undefined || (photo.expires_at !== null && photo.expires_at.getTime() <= now.getTime())) return undefined;
  return `${API_PREFIX}/rider/trips/${tripId}/driver-photo`;
}

const unavailable = () => notFound("No driver photo for this trip.", "driver_photo_unavailable");

/** GET /rider/trips/{tripId}/driver-photo: the trip's own rider, while a driver is assigned, the approved photo only. */
export async function riderDriverPhoto(ex: Executor, key: DocumentKey, riderId: string, tripId: string, now: Date): Promise<{ mediaType: string; fileName: string; bytes: Buffer }> {
  const trip = await ex.selectFrom("trips").select(["rider_id", "driver_id", "status"]).where("trip_id", "=", tripId).executeTakeFirst();
  if (trip === undefined || trip.rider_id !== riderId || trip.driver_id === null || !DRIVER_ASSIGNED.has(trip.status as TripStatus)) throw unavailable();
  const photo = await approvedPhoto(ex, trip.driver_id);
  if (photo === undefined || photo.media_type === null || (photo.expires_at !== null && photo.expires_at.getTime() <= now.getTime())) throw unavailable();
  const sealed = await ex.selectFrom("document_files").selectAll().where("document_id", "=", photo.document_id).executeTakeFirst();
  if (sealed === undefined) throw unavailable();
  return { mediaType: photo.media_type, fileName: "driver", bytes: openFile(key, sealed) };
}
