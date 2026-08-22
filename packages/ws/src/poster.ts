import {
  ApiGatewayManagementApiClient,
  DeleteConnectionCommand,
  GetConnectionCommand,
  GoneException,
  PostToConnectionCommand,
} from "@aws-sdk/client-apigatewaymanagementapi";
import { nullLogger, type Logger } from "@yyt/core";

/** Transport seam so handlers can be tested with a recording fake. */
export interface PosterTransport {
  post(connectionId: string, data: Uint8Array): Promise<void>;
  disconnect(connectionId: string): Promise<void>;
  /** `GetConnection`; resolves `false` on 410. */
  probe(connectionId: string): Promise<boolean>;
}

export interface PosterOptions {
  /** `https://{apiId}.execute-api.{region}.amazonaws.com/{stage}` */
  endpoint: string;
  /** Called when a connection is gone (410) so the caller can drop it from state. */
  onGone?: (connectionId: string) => Promise<void> | void;
  /** Max payload bytes; default 16KB per `docs/decisions.md`. */
  maxBytes?: number;
  transport?: PosterTransport;
  logger?: Logger;
}

export interface Poster {
  /** Returns `true` if delivered, `false` if the connection is gone (already cleaned up). */
  send(connectionId: string, message: unknown): Promise<boolean>;
  /** Sends to all; never throws for a dead socket. Returns the ids that were gone. */
  broadcast(
    connectionIds: Iterable<string>,
    message: unknown,
  ): Promise<string[]>;
  disconnect(connectionId: string): Promise<void>;
  /**
   * `true` once API Gateway has finished `$connect` for the id. A connection
   * cannot be posted to from inside its own `$connect` handler, so work that
   * was deferred from `$connect` polls this before sending.
   */
  isConnected(connectionId: string): Promise<boolean>;
}

export function createAwsTransport(endpoint: string): PosterTransport {
  const client = new ApiGatewayManagementApiClient({ endpoint });
  return {
    post: async (ConnectionId, Data) => {
      await client.send(new PostToConnectionCommand({ ConnectionId, Data }));
    },
    disconnect: async (ConnectionId) => {
      await client.send(new DeleteConnectionCommand({ ConnectionId }));
    },
    probe: async (ConnectionId) => {
      try {
        await client.send(new GetConnectionCommand({ ConnectionId }));
        return true;
      } catch (e) {
        if (isGone(e)) return false;
        throw e;
      }
    },
  };
}

export function isGone(e: unknown): boolean {
  if (e instanceof GoneException) return true;
  const o = e as {
    name?: string;
    $metadata?: { httpStatusCode?: number };
  } | null;
  return o?.name === "GoneException" || o?.$metadata?.httpStatusCode === 410;
}

export function createPoster({
  endpoint,
  onGone,
  maxBytes = 16 * 1024,
  transport,
  logger = nullLogger,
}: PosterOptions): Poster {
  const t = transport ?? createAwsTransport(endpoint);
  const encoder = new TextEncoder();

  function encode(message: unknown): Uint8Array {
    const data = encoder.encode(
      typeof message === "string" ? message : JSON.stringify(message),
    );
    if (data.byteLength > maxBytes)
      throw new Error(
        `message of ${data.byteLength} bytes exceeds ${maxBytes}`,
      );
    return data;
  }

  async function post(
    connectionId: string,
    data: Uint8Array,
  ): Promise<boolean> {
    try {
      await t.post(connectionId, data);
      return true;
    } catch (e) {
      if (isGone(e)) {
        logger.debug("connection gone", { connectionId });
        await onGone?.(connectionId);
        return false;
      }
      throw e;
    }
  }

  return {
    send: async (connectionId, message) => post(connectionId, encode(message)),
    broadcast: async (ids, message) => {
      const gone: string[] = [];
      const list = [...ids];
      const data = encode(message); // size-checked once, before any fan-out
      const results = await Promise.allSettled(
        list.map(async (id) => ({ id, ok: await post(id, data) })),
      );
      results.forEach((r, i) => {
        if (r.status === "fulfilled") {
          if (!r.value.ok) gone.push(r.value.id);
        } else {
          logger.warn("broadcast send failed", {
            connectionId: list[i],
            message:
              r.reason instanceof Error ? r.reason.message : String(r.reason),
          });
        }
      });
      return gone;
    },
    disconnect: async (id) => {
      try {
        await t.disconnect(id);
      } catch (e) {
        if (!isGone(e)) throw e;
      }
    },
    isConnected: (id) => t.probe(id),
  };
}
