# @yyt/http

Router for API Gateway httpApi (payload v2).

## Public API

- `createHttpHandler({routes, identity?, maxBodyBytes=64KB, cors?, logger?})` → Lambda handler.
  - `Route {method, path ("/c/{ch}/start", trailing "*" allowed), body?: zod, query?: zod, auth?: boolean, handler(ctx)}`.
  - `RouteContext {event, params, body, query, identity?, requireIdentity(), headers (lower-case), cookies, bearer?, requestId, logger}`.
  - Handler return: plain object → 200 JSON, `undefined` → 204, `HttpResult` → as is.
  - `AppError` → `{error:{code,message,details?}}` with its status; other exceptions → 500 `internal` (details logged, never returned). 5xx logs include `cause.message` (driver codes only).
  - `identity({bearer, cookies, event})` resolves sessions/API tokens; `auth: true` routes return 401 without identity.
  - CORS headers only for origins in `cors.origins`; OPTIONS → 204. `origins:["*"]` with `credentials:true` is refused.
- `defineRoute({...})` — keeps zod inference for body/query inside heterogeneous `AnyRoute[]` tables.
- `json(body, {status?, headers?, cookies?})`, `redirect(location, {...})`, `noContent()`.
- `parseBearer(headers)`, `parseCookies(headers, cookies?)`, `serializeCookie(name, value, {maxAgeSec, path, domain, secure=true, httpOnly=true, sameSite="Lax"})`, `parseJsonBody`.
- `compilePath`, `matchPath`.
