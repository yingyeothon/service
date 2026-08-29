import type { EventDetail, EventInput } from "../types";

export const OPTIONS_MAX = 10;
export const DURATION_HOURS_MAX = 72;

/** Unix seconds → `datetime-local` value in the browser's zone (`YYYY-MM-DDTHH:mm`). */
export function toLocalInput(sec: number | null | undefined): string {
  if (sec === null || sec === undefined) return "";
  const d = new Date(sec * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** `datetime-local` value → unix seconds; `null` when empty or unparseable. */
export function fromLocalInput(v: string): number | null {
  if (!v) return null;
  const ms = new Date(v).getTime();
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}

export interface EventFormState {
  title: string;
  bodyMd: string;
  place: string;
  placeUrl: string;
  durationHours: number;
  voteUntil: string;
  options: string[];
}

export const emptyEventForm = (): EventFormState => ({
  title: "",
  bodyMd: "",
  place: "",
  placeUrl: "",
  durationHours: 8,
  voteUntil: "",
  options: [""],
});

export function formFromEvent(e: EventDetail): EventFormState {
  return {
    title: e.title,
    bodyMd: e.bodyMd,
    place: e.place,
    placeUrl: e.placeUrl ?? "",
    durationHours: e.durationHours,
    voteUntil: toLocalInput(e.voteUntil),
    options: e.options.map((o) => toLocalInput(o.startsAt)),
  };
}

/**
 * Validates and converts the form. `schedule: false` (an event past draft)
 * leaves the vote fields out of both the checks and the result.
 */
export function buildEventInput(
  f: EventFormState,
  schedule: boolean,
): { input: EventInput | Partial<EventInput>; error: string | null } {
  const title = f.title.trim();
  const place = f.place.trim();
  const placeUrl = f.placeUrl.trim();
  if (!title) return { input: {}, error: "Title is required." };
  if (!place) return { input: {}, error: "Place is required." };
  if (placeUrl && !/^https?:\/\/\S+$/i.test(placeUrl))
    return { input: {}, error: "Map link must be an http(s) URL." };
  const page = { title, bodyMd: f.bodyMd, place, placeUrl: placeUrl || null };
  if (!schedule) return { input: page, error: null };
  if (
    !Number.isInteger(f.durationHours) ||
    f.durationHours < 1 ||
    f.durationHours > DURATION_HOURS_MAX
  )
    return {
      input: {},
      error: `Duration must be 1–${DURATION_HOURS_MAX} hours.`,
    };
  const voteUntil = fromLocalInput(f.voteUntil);
  if (voteUntil === null)
    return { input: {}, error: "Vote deadline is required." };
  const options = f.options
    .map((o) => o.trim())
    .filter(Boolean)
    .map(fromLocalInput);
  if (options.length === 0 || options.some((o) => o === null))
    return { input: {}, error: "Add at least one candidate date." };
  const starts = options as number[];
  if (starts.length > OPTIONS_MAX)
    return { input: {}, error: `At most ${OPTIONS_MAX} candidate dates.` };
  if (new Set(starts).size !== starts.length)
    return { input: {}, error: "Candidate dates must differ." };
  if (starts.some((s) => s <= voteUntil))
    return {
      input: {},
      error: "Every candidate date must be after the vote deadline.",
    };
  return {
    input: {
      ...page,
      durationHours: f.durationHours,
      voteUntil,
      options: [...starts].sort((a, b) => a - b),
    },
    error: null,
  };
}
