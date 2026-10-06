import type {
  LimitRequestStatus,
  LimitScopeKind,
  LimitUnit,
  LimitValue,
} from "../types";

/*
 * Labels for the limit keys (docs/decisions.md *Limit requests* #1). Units,
 * soft and hard values come from the server on every row (`GET /limits`
 * rows, and `unit`/`hard` on a request), so the registry itself lives only in
 * `services/console/src/limits.ts`. A key without a label shows as itself.
 */

const KiB = 1024;
const MiB = 1024 * KiB;
const GiB = 1024 * MiB;

export const LIMIT_LABELS: Record<string, string> = {
  "asset.fileBytes": "File size",
  "asset.bundleBytes": "Bundle size",
  "asset.versionsPerBundle": "Versions",
  "asset.filesPerVersion": "Files per version",
  "asset.filesPerBundle": "Files",
  "asset.mutableFileBytes": "Mutable file size",
  "asset.projectBytes": "Project asset size",
  "asset.bundlesPerProject": "Bundles",
  "channel.lifetime": "Lifetime",
  "team.projects": "Projects",
  "push.appsPerTeam": "Push apps",
  "push.recipientsPerJob": "Recipients per job",
  "push.jobsPerDay": "Jobs per day",
  "kv.maxEntries": "Entries cap",
  "kv.maxEntriesPerOwner": "Entries per owner cap",
  "kv.collections": "Collections",
};

export const limitLabel = (key: string): string => LIMIT_LABELS[key] ?? key;

/** `bundle:ab_1` — the `scope` of `GET /limits` and `POST /limit-requests`. */
export const limitScope = (kind: LimitScopeKind, id: string): string =>
  `${kind}:${id}`;

/**
 * Bytes in the binary units the limits are defined and typed in: an exact
 * multiple as it is ("2 MiB", "3 GiB", "256 KiB"), anything else to one
 * decimal ("1.5 MiB"). `fmtSize` stays the console's size for files.
 */
export function fmtBytes(n: number): string {
  if (n < KiB) return `${n} B`;
  const unit = n >= GiB ? "GiB" : n >= MiB ? "MiB" : "KiB";
  const v = n / BYTE_UNITS[unit];
  return `${Number.isInteger(v) ? v : v.toFixed(1)} ${unit}`;
}

/** A value as the tables show it. */
export function fmtLimit(unit: LimitUnit, v: LimitValue): string {
  if (v === "unlimited") return unit === "seconds" ? "No expiry" : "Unlimited";
  if (unit === "bytes") return fmtBytes(v);
  if (unit === "seconds") {
    const days = Math.round(v / 86400);
    return `${days} day${days === 1 ? "" : "s"}`;
  }
  return v.toLocaleString("en-US");
}

/** A request's value in its own unit (a retired key prints as a count). */
export const fmtRequestValue = (
  r: { unit: LimitUnit | null },
  v: LimitValue,
): string => fmtLimit(r.unit ?? "count", v);

export const LIMIT_STATUS_TONE: Record<LimitRequestStatus, string> = {
  pending: "warn",
  approved: "ok",
  rejected: "danger",
  cancelled: "neutral",
};

export type ByteUnit = "KiB" | "MiB" | "GiB";
export const BYTE_UNITS: Record<ByteUnit, number> = {
  KiB,
  MiB,
  GiB,
};

/** `NumberInput` hands back `""` while a field is being retyped. */
export type Amount = number | string;

const UNITS_DOWN: ByteUnit[] = ["GiB", "MiB", "KiB"];

/**
 * The form's amount and unit for a byte value: the largest unit that divides
 * it, else the largest it reaches (a fraction; powers of two keep it exact,
 * so converting back gives the same bytes).
 */
export function splitBytes(v: number): { amount: number; unit: ByteUnit } {
  const fit =
    UNITS_DOWN.find((u) => v >= BYTE_UNITS[u] && v % BYTE_UNITS[u] === 0) ??
    UNITS_DOWN.find((u) => v >= BYTE_UNITS[u]) ??
    "KiB";
  return { amount: v / BYTE_UNITS[fit], unit: fit };
}

/** The unit a new byte amount is typed in: MiB, or KiB below 1 MiB. */
export const defaultByteUnit = (current: LimitValue): ByteUnit =>
  typeof current === "number" && current < MiB ? "KiB" : "MiB";

/**
 * What the form asks for, or `null` while it is not a value yet. A lifetime
 * is always `unlimited` (#7); bytes may be typed with a fraction (1.5 GiB)
 * and are rounded to whole bytes; counts must be whole.
 */
export function formLimitValue(
  unit: LimitUnit,
  amount: Amount,
  byteUnit: ByteUnit,
): LimitValue | null {
  if (unit === "seconds") return "unlimited";
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0)
    return null;
  if (unit === "bytes") {
    const v = Math.round(amount * BYTE_UNITS[byteUnit]);
    return v > 0 ? v : null;
  }
  return Number.isSafeInteger(amount) ? amount : null;
}

/**
 * Why `value` cannot be asked for (or granted), or `null`. `above` is the
 * current effective value a request must exceed; an approval passes none.
 */
export function limitValueProblem(
  unit: LimitUnit,
  value: LimitValue | null,
  hard: LimitValue | undefined,
  above?: LimitValue,
): string | null {
  if (value === null)
    return unit === "count" ? "A whole number above 0." : "A number above 0.";
  if (value === "unlimited") return null;
  if (typeof hard === "number" && value > hard)
    return `At most ${fmtLimit(unit, hard)}.`;
  if (typeof above === "number" && value <= above)
    return `More than the current ${fmtLimit(unit, above)}.`;
  return null;
}
