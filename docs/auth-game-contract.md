# 인증 설계 — 인스턴트 던전

> 이 문서는 **서비스 레이어**가 소유한다.
> tslib(`@yingyeothon/*`)는 검증 **자리**만 제공하고, 누가 무엇으로 서명하는지는 전부 여기서 정한다.
> todo.md §3(게이트웨이), §4(로비/매치메이커), §5(인증/계정)와 짝을 이룬다.

## 0. 결정 요약

| 항목 | 결정 |
| --- | --- |
| 신원의 출처 | 로비/매치메이커가 발급한 **JWT의 클레임**. `x-member-id` 헤더는 절대 신뢰하지 않는다 |
| 서명 | **HS256 대칭키**. 참가자별 채널마다 별도 시크릿 |
| 검증 위치 | API Gateway **REQUEST authorizer**(`$connect` 전용) 1곳. `$default`는 재검증하지 않는다 |
| 키 배포 | 게임 Lambda 환경변수 `JWT_SECRET_KEY`. **참가자당 게임 스택을 별도 배포**하므로 단일 시크릿으로 충분 |
| 토큰 전달 | `Sec-WebSocket-Protocol: bearer, <token>` (서브프로토콜). 쿼리스트링은 액세스 로그에 남으므로 쓰지 않는다 |
| 토큰 수명 | 판 확정 시각 + **60분**. 15분 던전 + 로비 대기 + 모바일 재접속을 전부 덮는다 |
| 재접속 | **같은 토큰 재사용**. 재발급 엔드포인트 없음 |
| 익명 여부 | 게임 쪽은 무관. 계정이든 디바이스 id든 로비가 정하고 `sub`에 담는다 |

## 1. 토큰에 담아야 하는 정보

로비가 서명하는 JWT의 클레임. **검증** 열이 `필수`인 것은 게임 Lambda가 실제로 검사한다.

| 클레임 | 값 | 검증 | 이유 |
| --- | --- | --- | --- |
| `sub` | `memberId` | 필수 | 이것이 신원 그 자체. `GameActorStartEvent.members[].memberId` 와 **문자열이 정확히 같아야** 한다. 서명이 맞아도 `sub` 이 없으면 authorizer 가 거부한다 |
| `iss` | 인증 채널의 `issuerId` (예: `yyt-lobby/ch_a1b2c3`) | 필수 | 서명이 유효하다는 것은 "이 시크릿을 가진 누군가가 만들었다"일 뿐, 어느 채널인지는 말해주지 않는다 |
| `aud` | 이 게임 배포의 식별자 (예: `instant-dungeon-teamA`) | 필수 | 한 채널이 여러 배포를 가질 때 A용 토큰이 B에 통하는 것을 막는다 |
| `exp` | 판 확정 시각 + 60분 | 필수 | §3 참고. 짧으면 진행 중인 판에서 재접속이 막힌다. **`exp` 없는 토큰은 라이브러리가 거부한다**(`requireExpiry` 기본 `true`) |
| `iat` | 발급 시각 | 자동 | |
| `jti` | 발급 단위 고유 id | 선택 | 지금은 안 쓴다. 나중에 취소 목록/재사용 추적을 붙일 때의 손잡이 |
| `gameId` | 판 id | 선택 | 토큰을 한 판에 묶고 싶을 때. §6 참고 |

**절대 담지 않는다**: `name`, `email`, 그 밖의 PII. 클레임에서 뽑은 값은 authorizer context 로 들어가고,
API Gateway 를 `$context.authorizer.*` 를 액세스 로그에 쓰도록 설정할 수 있다. 즉 **클레임에 넣은 것은 로그에 남을 수 있다**.

게임 Lambda 로 넘어가는 authorizer context 는 기본값 기준 `{ memberId }` **하나뿐**이고,
같은 값이 policy 의 `principalId` 로도 나간다. 검증된 토큰 원문은 context 에 넣지 않는다
(클라이언트는 이미 갖고 있다). 거부된 요청에는 context 가 아예 붙지 않는다.

## 2. 게임 Lambda 쪽에 필요한 설정

참가자가 자기 스택을 배포할 때 채우는 값. 전부 로비가 채널 발급 시 알려준다.

| 환경변수 | 예 | 용도 |
| --- | --- | --- |
| `JWT_SECRET_KEY` | (채널 시크릿) | HS256 검증 키 |
| `JWT_ISSUER` | `yyt-lobby/ch_a1b2c3` | `iss` 기대값 |
| `JWT_AUDIENCE` | `instant-dungeon-teamA` | `aud` 기대값 |

`process.env` 읽기는 **서비스 핸들러**에서 한다. tslib 라이브러리 코드는 환경변수를 읽지 않는다(`CONVENTIONS.md`).

### `$connect` authorizer

```ts
// authorizer.ts — API Gateway REQUEST authorizer
import { createJwtRequestAuthorizer } from "@yingyeothon/lambda-authorizer-jwt";

export const handler = createJwtRequestAuthorizer({
  jwtSecret: process.env.JWT_SECRET_KEY!,
  verifyOptions: {
    issuer: process.env.JWT_ISSUER!,
    audience: process.env.JWT_AUDIENCE!,
  },
});
```

API Gateway 설정:

- 타입: **REQUEST** (WebSocket API 는 TOKEN authorizer 를 지원하지 않는다)
- 부착 라우트: **`$connect` 뿐** (다른 라우트에는 붙일 수 없다)
- Identity source: `route.request.header.Sec-WebSocket-Protocol`
- **Cache TTL: 0** — `$connect` 는 연결당 1회라 캐시 이득이 없고, 캐시가 `exp` 보다 오래 살면 만료 토큰으로 접속이 된다
- 위 둘은 사실 같은 결정이다. **캐시를 끄면** API Gateway 가 identity source 를 검사하지 않고 그대로 Lambda 를 부른다.
  **캐시를 켜면** 선언한 identity source 가 **전부** 있어야 하고 하나라도 비면 Lambda 를 부르지 않고 401 이다 —
  그 상태에서 헤더와 서브프로토콜을 둘 다 선언하면 브라우저 핸드셰이크가 전부 막힌다(브라우저는 서브프로토콜만 보낼 수 있다).
  캐시를 켤 일이 생기면 **실제로 클라이언트가 보내는 하나만** 선언할 것

### `$connect` 핸들러

```ts
// connect.ts
import { handleConnect } from "@yingyeothon/lambda-gamebase";

export const handler = (event) =>
  handleConnect({
    event,
    ...prefixes,
    context: gamebaseContext,
    resolveMemberId: (e) => {
      const memberId = e.requestContext.authorizer?.memberId;
      return typeof memberId === "string" ? memberId : undefined;
    },
    selectSubprotocol: (offered) =>
      offered.includes("bearer") ? "bearer" : undefined,
  });
```

- `resolveMemberId` 가 `undefined` 를 돌려주면 400 으로 닫힌다(fail closed).
- `selectSubprotocol` 없이는 **브라우저 핸드셰이크가 실패한다**. 서버가 고른 서브프로토콜을 응답 헤더로 되돌려주지 않으면 브라우저가 연결을 끊는다.
- `x-member-id` 헤더는 이제 완전히 무시된다. 클라이언트가 여전히 정하는 값은 `x-game-id` 뿐이고, 그것은 start event 의 멤버십 검사로 걸러진다.

## 3. 핸드셰이크 흐름

```
1. 클라 → 로비        : 로그인/식별
2. 로비              : 파티 확정 → GameActorStartEvent 저장(Redis)
                       → JWT 서명 (sub=memberId, iss=채널, aud=배포, exp=now+60m)
3. 로비 → 클라        : { wsUrl, gameId, token }
4. 클라              : new WebSocket(`${wsUrl}?x-game-id=${gameId}`, ["bearer", token])
5. API Gateway       : REQUEST authorizer 실행 → 검증 → context { memberId }
6. $connect          : handleConnect → 멤버십 확인 → conn:{connectionId} = gameId
                       → 액터 큐에 { type: "enter", connectionId, memberId }
                       → 200 + Sec-WebSocket-Protocol: bearer
7. 끊김 → 재접속      : 같은 토큰으로 4번부터 반복. processEnter 가 슬롯을 새 connectionId 로 다시 묶는다
```

**`gameId` 는 쿼리스트링으로 간다.** 브라우저는 WS 핸드셰이크에 헤더를 못 붙이고, `gameId` 는 비밀이 아니다.
비밀인 것은 토큰뿐이고 그것만 서브프로토콜로 뺀다.

`exp` 를 60분으로 잡는 이유: 15분 던전이라도 로비 대기 + 레디체크 + 지하철 재접속을 합치면 30분을 넘길 수 있다.
토큰이 판 도중 만료되면 재접속이 401 로 막혀 **진행 중인 판에서 영구 퇴장**한다. 인증이 없느니만 못한 UX다.

## 4. 공용 로비 + 참가자별 인증 채널

기대하는 그림: 해커톤 참가자가 등록하면 공용 로비/매치메이커가 인증 채널을 하나 할당하고,
참가자는 그 채널로 인증한 유저를 자기 게임 Lambda 에서 그대로 이어받는다.

채널 = `{ issuerId, secret, audience }` 한 벌.

```
등록  : 참가자 → 로비        : 팀 등록
발급  : 로비 → 참가자        : { issuerId, secret, audience }
배포  : 참가자              : 게임 스택에 JWT_SECRET_KEY / JWT_ISSUER / JWT_AUDIENCE 설정
운영  : 유저 → 로비 → 참가자 게임
        로비가 그 참가자 채널의 secret 으로 서명 → 참가자 게임이 자기 채널 토큰만 통과
```

**참가자당 별도 배포**라서 환경변수 하나로 성립한다. 게임 Lambda 는 자기 채널 하나만 알면 되고,
인증 경로에 키 조회(Redis/SSM)가 끼어들지 않는다.

채널을 참가자별로 쪼개는 진짜 값어치는 **폭발 반경**이다. HS256 은 대칭키라
게임 Lambda 가 검증 키가 아니라 **서명 키**를 갖는다. 참가자 A 의 게임이 털리면
공격자는 A 채널의 아무 사용자나 위조할 수 있지만, 로비 자체와 다른 참가자의 채널은 무사하다.

## 5. 이 설계가 감수하는 것

결정된 사항이며, 아래는 알고 받아들인 비용이다.

1. **게임 Lambda 가 서명 능력을 갖는다.** 유출 시 그 채널 한정 위조 가능. 채널 분리로 폭발 반경을 참가자 1명으로 제한한다.
2. **시크릿이 이동한다.** 로비 → 참가자 → Lambda 환경변수. 이 경로 자체가 유출점이고, 로테이션은 재배포를 뜻한다.
3. **토큰 취소가 불가능하다.** 발급된 토큰은 `exp` 까지 유효하고 창이 60분이다.
   연결이 수립된 뒤의 추방은 authorizer 가 못 한다 — 게임 루프가 `Transport.drop` 으로 끊어야 한다(§7 밴/치팅 대응).
4. **로비와 게임의 `memberId` 계약이 문서상 계약일 뿐이다.** `sub` 과 `GameActorStartEvent.members[].memberId` 가
   어긋나면 조용히 400 이 난다. 로비 쪽에서 같은 변수로 두 곳을 채우도록 강제할 것.
5. **인증은 "누구"만 정한다.** 한 멤버가 동시에 여러 소켓을 여는 것, 재접속으로 밀려난 옛 커넥션이
   TTL 만료 전까지 `$default` 로 메시지를 계속 넣을 수 있는 것 — 둘 다 인증으로 닫히지 않는다.
   §3 의 연결당 rate limit 과 §2 의 시퀀스 번호가 담당한다.

## 6. 나중에 다시 볼 것

- **`gameId` 클레임으로 토큰을 한 판에 묶기.** 지금은 사용자 토큰이라 그 유저가 멤버인 다른 판에도 쓸 수 있다.
  (정상 동작이지만 창을 좁히고 싶다면) `buildContext` 로 `gameId` 를 context 에 실은 뒤,
  `$connect` 핸들러에서 `handleConnect` 호출 **전에** `x-game-id` 와 비교하면 된다.
- **공용 게임 Lambda(멀티테넌트)로 갈 때.** 환경변수 하나로는 N 개 채널을 담을 수 없다.
  `iss` 또는 JWT 헤더의 `kid` 로 키를 조회해야 하고, 그 시점에 tslib 의 `verifyBearer` 에
  키 해석 콜백을 추가하는 변경이 필요하다.
- **비대칭(RS256/EdDSA) + JWKS 로 전환.** 로비만 개인키를 갖고 게임은 공개키로 검증만 하면
  §5 의 1·2 번이 통째로 사라진다. 비밀이 이동하지 않고 로테이션이 공짜다.
  멀티테넌트로 갈 거라면 그때 같이 하는 게 맞다.
- **자체 호스팅 게이트웨이로 전환할 때(§3).** authorizer 가 사라지므로 게이트웨이 프로세스가
  같은 규칙(`iss`/`aud`/`exp`)으로 직접 검증한다. 토큰 형식과 클레임 계약은 그대로 살아남는다 —
  그것이 이 설계를 authorizer 가 아니라 **토큰 규약** 중심으로 적은 이유다.

## 7. 체크리스트

- [ ] 로비: 채널 발급 API (`issuerId` / `secret` / `audience` 생성·조회·폐기)
- [ ] 로비: 파티 확정 시 JWT 서명. `sub` 은 start event 를 채운 것과 **같은 변수**로
- [ ] 로비: `exp = 판 확정 + 60분`
- [ ] 게임: `authorizer.ts` — `createJwtRequestAuthorizer`, `iss`/`aud` 고정
- [ ] 게임: API Gateway REQUEST authorizer, `$connect` 부착, identity source `route.request.header.Sec-WebSocket-Protocol`, **cache TTL 0**
- [ ] 게임: `$connect` 핸들러에 `resolveMemberId` + `selectSubprotocol`
- [ ] 클라: `new WebSocket(wsUrl + "?x-game-id=" + gameId, ["bearer", token])`
- [ ] 클라: 재접속 시 같은 토큰 재사용, `exp` 임박하면 로비 복귀
- [ ] 액세스 로그에 `$context.authorizer.*` 를 켜지 않았는지 확인
- [ ] 시크릿을 참가자에게 전달하는 경로 결정 (콘솔 1회 노출? 파라미터 스토어?)
