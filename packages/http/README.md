# @yyt/http

API Gateway httpApi(payload v2) 라우터.

## Public API

- `createHttpHandler({routes, identity?, maxBodyBytes=64KB, cors?, logger?})` → Lambda 핸들러.
  - `Route {method, path("/c/{ch}/start", 끝 "*" 허용), body?: zod, query?: zod, auth?: boolean, handler(ctx)}`.
  - `RouteContext {event, params, body, query, identity?, requireIdentity(), headers(소문자), cookies, bearer?, requestId, logger}`.
  - 핸들러 반환: 일반 객체 → 200 JSON, `undefined` → 204, `HttpResult` → 그대로.
  - `AppError` → `{error:{code,message,details?}}` + status; 그 외 예외 → 500 `internal`(내용 숨김, 로그만).
  - `identity({bearer, cookies, event})` 로 세션/API 토큰을 해석; `auth: true` 라우트는 identity 없으면 401.
  - `cors.origins` 허용 목록에 있는 Origin 에만 헤더 부여, OPTIONS 는 204.
- `json(body, {status?, headers?, cookies?})`, `redirect(location, {...})`, `noContent()`.
- `parseBearer(headers)`, `parseCookies(headers, cookies?)`, `serializeCookie(name, value, {maxAgeSec, path, domain, secure=true, httpOnly=true, sameSite="Lax"})`, `parseJsonBody`.
- `compilePath`, `matchPath`.
