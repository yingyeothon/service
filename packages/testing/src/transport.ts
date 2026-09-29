import type { PosterTransport } from "@yyt/ws";
import { vi } from "vitest";

export interface Sent {
  id: string;
  msg: Record<string, unknown>;
}

/**
 * Records posts; `gone` ids answer 410 on post/probe; `pending` ids are "not
 * yet connected". The name-only `GoneException` is what `@yyt/ws` checks for;
 * the package's own suite throws the SDK class to prove that check.
 */
export function fakeTransport(
  gone: string[] = [],
  pending = new Set<string>(),
) {
  const sent: Sent[] = [];
  const closed: string[] = [];
  const transport: PosterTransport = {
    post: vi.fn(async (id: string, data: Uint8Array) => {
      if (gone.includes(id) || pending.has(id)) {
        const e = new Error("gone") as Error & { name: string };
        e.name = "GoneException";
        throw e;
      }
      sent.push({
        id,
        msg: JSON.parse(Buffer.from(data).toString("utf8")) as Record<
          string,
          unknown
        >,
      });
    }),
    disconnect: vi.fn(async (id: string) => {
      closed.push(id);
    }),
    probe: vi.fn(async (id: string) => !gone.includes(id) && !pending.has(id)),
  };
  return { transport, sent, closed, pending };
}
