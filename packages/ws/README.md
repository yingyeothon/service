# @yyt/ws

API Gateway WebSocket 헬퍼.

## Public API

- `extractBearerSubprotocol(event)` — `Sec-WebSocket-Protocol: bearer, <token>` 에서 토큰 추출(`headers`/`multiValueHeaders`).
- `subprotocolResponse(status=200)` — `$connect` 응답에 `Sec-WebSocket-Protocol: bearer` 를 에코(브라우저 필수).
- `allowPolicy(principalId, methodArn, context?)`, `denyPolicy(methodArn)` — REQUEST authorizer 결과.
- `createPoster({endpoint, onGone?, maxBytes=16KB, transport?, logger?})`
  - `send(id, msg)` → 전달되면 `true`, 410(Gone) 이면 `onGone(id)` 호출 후 `false`.
  - `broadcast(ids, msg)` → 죽은 소켓은 건너뛰고 gone id 목록 반환; 다른 오류는 로그만.
  - `disconnect(id)`.
  - `PosterTransport` 로 테스트 시 fake 주입.
