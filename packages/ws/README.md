# @yyt/ws

API Gateway WebSocket helpers.

## Public API

- `extractBearerSubprotocol(event)` — token from `Sec-WebSocket-Protocol: bearer, <token>` (`headers`/`multiValueHeaders`).
- `subprotocolResponse(status=200)` — `$connect` response echoing `Sec-WebSocket-Protocol: bearer` (required by browsers).
- `allowPolicy(principalId, methodArn, context?)`, `denyPolicy(methodArn)` — REQUEST authorizer results.
- `createPoster({endpoint, onGone?, maxBytes=16KB, transport?, logger?})`
  - `send(id, msg)` → `true` when delivered; on 410 Gone calls `onGone(id)` and returns `false`.
  - `broadcast(ids, msg)` → skips dead sockets, returns the gone ids; other errors are only logged.
  - `disconnect(id)`.
  - Inject a fake `PosterTransport` in tests.
