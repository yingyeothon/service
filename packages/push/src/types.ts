/** The part of a `fetch` response this package reads. */
export interface PushHttpResponse {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

/**
 * The injected HTTP seam. The global `fetch` satisfies it; so does
 * `createFakeGoogle().fetch`.
 */
export type PushFetch = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<PushHttpResponse>;

export type Sleep = (ms: number) => Promise<void>;

export const timerSleep: Sleep = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
