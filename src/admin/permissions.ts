import { contract } from "../contract/contract.js";

/**
 * Admin roles and permissions (contract v0.5.1 §9, contract.json#adminPermissions). The role table is the admin
 * panel's own (webapp/src/auth/permissions.ts ROLE_PERMISSIONS), so the panel and the server agree on who may do
 * what. `super` has every permission and never needs a second admin (owner decision 14).
 */

export const ADMIN_PERMISSIONS: readonly string[] = (contract as unknown as { adminPermissions: { values: string[] } }).adminPermissions.values;

export const ADMIN_ROLES = ["viewer", "support", "dispatcher", "compliance", "finance", "safety", "content", "config", "fleet", "ops", "super"] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];

const OVERVIEW = ["overview.read"];

const TABLE: Record<Exclude<AdminRole, "super">, readonly string[]> = {
  viewer: [...OVERVIEW, "trips.read", "drivers.read", "riders.read", "zones.read"],
  support: [...OVERVIEW, "trips.read", "trips.annotate", "riders.read", "riders.viewSensitive", "support.reply"],
  dispatcher: [...OVERVIEW, "trips.read", "trips.annotate", "trips.intervene", "drivers.read", "drivers.viewSensitive", "zones.read"],
  compliance: [...OVERVIEW, "drivers.read", "drivers.viewSensitive", "drivers.activate", "documents.approve", "vehicles.edit", "zones.read"],
  finance: [...OVERVIEW, "riders.read", "finance.read", "finance.edit", "payments.refund", "audit.read", "approval.decide"],
  safety: [...OVERVIEW, "trips.read", "trips.annotate", "riders.read", "riders.viewSensitive", "incidents.read", "safety.edit"],
  content: [...OVERVIEW, "settings.read", "settings.edit"],
  config: [...OVERVIEW, "zones.read", "zones.edit", "zones.publish", "settings.read", "settings.edit", "settings.publish", "audit.read", "approval.decide"],
  fleet: [...OVERVIEW, "drivers.read", "drivers.viewSensitive", "documents.approve", "vehicles.edit", "zones.read"],
  ops: [
    ...OVERVIEW,
    "trips.read", "trips.annotate", "trips.intervene",
    "drivers.read", "drivers.viewSensitive", "drivers.activate", "documents.approve", "vehicles.edit",
    "riders.read", "riders.viewSensitive", "riders.block", "riders.promotions",
    "drivers.bonuses", "dispatch.edit", "dispatch.approve", "alerts.manage",
    "zones.read", "zones.edit", "zones.publish", "support.reply", "incidents.read", "safety.edit",
    "settings.read", "settings.edit", "settings.publish", "audit.read", "approval.decide",
  ],
};

for (const [role, permissions] of Object.entries(TABLE)) {
  for (const permission of permissions) {
    if (!ADMIN_PERMISSIONS.includes(permission)) throw new Error(`Role ${role}: ${permission} is not in contract.json#adminPermissions`);
  }
}

export function isAdminRole(value: string): value is AdminRole {
  return (ADMIN_ROLES as readonly string[]).includes(value);
}

/** Fully expanded, in the contract's order. */
export function permissionsOf(role: AdminRole): string[] {
  if (role === "super") return [...ADMIN_PERMISSIONS];
  const own = new Set(TABLE[role]);
  return ADMIN_PERMISSIONS.filter((permission) => own.has(permission));
}
