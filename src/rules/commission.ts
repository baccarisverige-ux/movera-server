/**
 * v0.18.10 (contract.json#finish.debt, live bug 2026-11-01): Movera's commission on a trip never includes an earlier
 * unpaid fee the rider pays with it (the outstanding_fee line). That money settles the old trip's fee, whose driver
 * share was credited back then: commission = fare − debtCollected − driverEarnings − pickupPay − driverBonus.
 */
type Line = { code: string; amount: { amountMinor: number } };

/** The trip's outstanding_fee line (an older fee carried by this trip), 0 when none. */
export function debtOf(lines: unknown): number {
  const list = typeof lines === "string" ? (JSON.parse(lines) as Line[]) : ((lines as Line[] | null) ?? []);
  return list.filter((l) => l.code === "outstanding_fee").reduce((sum, l) => sum + Number(l.amount.amountMinor), 0);
}

export function commissionOf(fareMinor: number, lines: unknown, earnings: number, pickupPay: number, bonus: number): number {
  return fareMinor - debtOf(lines) - earnings - pickupPay - bonus;
}
