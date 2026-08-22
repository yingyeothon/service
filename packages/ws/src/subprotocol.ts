export const BEARER_SUBPROTOCOL = "bearer";

interface HeaderCarrier {
  headers?: Record<string, string | undefined> | null;
  multiValueHeaders?: Record<string, string[] | undefined> | null;
}

/**
 * Reads `Sec-WebSocket-Protocol: bearer, <token>` from a `$connect` event
 * (REQUEST authorizer or the connect handler). Returns the token or `undefined`.
 */
export function extractBearerSubprotocol(
  event: HeaderCarrier,
): string | undefined {
  const values: string[] = [];
  for (const [k, v] of Object.entries(event.headers ?? {})) {
    if (k.toLowerCase() === "sec-websocket-protocol" && v) values.push(v);
  }
  for (const [k, v] of Object.entries(event.multiValueHeaders ?? {})) {
    if (k.toLowerCase() === "sec-websocket-protocol" && v) values.push(...v);
  }
  const parts = values
    .flatMap((v) => v.split(","))
    .map((s) => s.trim())
    .filter(Boolean);
  const idx = parts.findIndex((p) => p.toLowerCase() === BEARER_SUBPROTOCOL);
  if (idx < 0) return undefined;
  const token = parts[idx + 1];
  if (!token || token.toLowerCase() === BEARER_SUBPROTOCOL) return undefined;
  return token;
}

/**
 * `$connect` must echo the selected subprotocol, otherwise browsers abort the
 * handshake. Spread into the connect handler's response.
 */
export function subprotocolResponse(statusCode = 200): {
  statusCode: number;
  headers: { "Sec-WebSocket-Protocol": string };
  body: string;
} {
  return {
    statusCode,
    headers: { "Sec-WebSocket-Protocol": BEARER_SUBPROTOCOL },
    body: "",
  };
}
