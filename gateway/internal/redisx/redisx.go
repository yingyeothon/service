// Package redisx is the gateway's Redis surface: the small set of commands
// the lobby and q strategies need, over one go-redis client. Every key it
// writes carries a TTL (`rules/data.md`), and the key layout is the one
// settled in `todo/14` §5:
//
//	gateway:{stage}:session:{kind}:{channelId}:{userId} -> connectionId
//	gateway:{stage}:pos:{channelId}:{userId}            -> {zone,x,y,dir}
//	gateway:{stage}:party:{channelId}:{partyId}         -> roster JSON
//	gateway:{stage}:partyOf:{channelId}:{userId}        -> partyId
//
// The `game:{stage}:{channelId}:*` keys of the actor bridge are named by the
// console (`internal/console.Redis`) and only pushed to here.
package redisx

import (
	"context"
	"errors"
	"fmt"
	"net"
	"regexp"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

// Client wraps go-redis with the gateway's key prefix.
type Client struct {
	rdb    redis.UniversalClient
	prefix string
}

// Open parses a `redis://` URL and connects. `enableReadyCheck`-style INFO
// probes are not run: the service account has `-@dangerous`, which removes
// INFO (`rules/data.md`).
func Open(ctx context.Context, rawURL, stage string) (*Client, error) {
	opt, err := redis.ParseURL(rawURL)
	if err != nil {
		// The error would echo the URL (and its password); replace it.
		return nil, errors.New("GATEWAY_REDIS_URL: not a valid redis:// URL")
	}
	opt.DialTimeout = 5 * time.Second
	opt.ReadTimeout = 5 * time.Second
	opt.WriteTimeout = 5 * time.Second
	opt.PoolSize = 8
	opt.MinIdleConns = 1
	opt.MaxRetries = 2
	rdb := redis.NewClient(opt)
	c := &Client{rdb: rdb, prefix: "gateway:" + stage + ":"}
	if err := c.Ping(ctx); err != nil {
		_ = rdb.Close()
		return nil, err
	}
	return c, nil
}

// Wrap adapts an existing client (tests use miniredis).
func Wrap(rdb redis.UniversalClient, stage string) *Client {
	return &Client{rdb: rdb, prefix: "gateway:" + stage + ":"}
}

// Close releases the pool.
func (c *Client) Close() error { return c.rdb.Close() }

// Ping is the health probe; `PING` is allowed to every account.
func (c *Client) Ping(ctx context.Context) error {
	if err := c.rdb.Ping(ctx).Err(); err != nil {
		return fmt.Errorf("redis: %w", sanitize(err))
	}
	return nil
}

// Raw exposes the underlying client for pub/sub and the actor bridge.
func (c *Client) Raw() redis.UniversalClient { return c.rdb }

// Key builds a gateway-prefixed key. Segments must not contain `:`; a user
// id or channel id is server-issued hex, so this is a guard, not validation.
func (c *Client) Key(segments ...string) string {
	return c.prefix + strings.Join(segments, ":")
}

// --- session -------------------------------------------------------------

// SessionTTL bounds a socket binding that stops being refreshed (§5: ~15 m).
const SessionTTL = 15 * time.Minute

// SessionKey is `session:{kind}:{channelId}:{userId}`.
func (c *Client) SessionKey(kind, channelID, userID string) string {
	return c.Key("session", kind, channelID, userID)
}

// ClaimSession records `connectionId` as the live socket of `(kind, channel,
// user)` and returns the connection id it replaced, if any. The gateway is a
// single process, so replacement is decided in memory; the key exists so the
// game's HTTP API can see who is online.
func (c *Client) ClaimSession(ctx context.Context, kind, channelID, userID, connectionID string) (previous string, err error) {
	key := c.SessionKey(kind, channelID, userID)
	// One `SET … EX GET` round trip (Redis ≥ 7 / Valkey): value and TTL land
	// together, so a crash between a `GETSET` and its `EXPIRE` can no longer
	// leave a TTL-less key behind.
	prev, err := c.rdb.SetArgs(ctx, key, connectionID, redis.SetArgs{TTL: SessionTTL, Get: true}).Result()
	if err != nil && !errors.Is(err, redis.Nil) {
		return "", fmt.Errorf("redis: %w", sanitize(err))
	}
	if prev == connectionID {
		return "", nil
	}
	return prev, nil
}

// TouchSession extends the binding on traffic.
func (c *Client) TouchSession(ctx context.Context, kind, channelID, userID string) error {
	return c.rdb.Expire(ctx, c.SessionKey(kind, channelID, userID), SessionTTL).Err()
}

// compareAndDelete is the same script `match` uses for `user:{ch}:{user}`.
var compareAndDelete = redis.NewScript(`if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`)

// ReleaseSession deletes the binding only if it still names this connection,
// so a replacement's key is never removed by the socket it replaced.
func (c *Client) ReleaseSession(ctx context.Context, kind, channelID, userID, connectionID string) error {
	err := compareAndDelete.Run(ctx, c.rdb, []string{c.SessionKey(kind, channelID, userID)}, connectionID).Err()
	if err != nil && !errors.Is(err, redis.Nil) {
		return fmt.Errorf("redis: %w", sanitize(err))
	}
	return nil
}

// --- retained position ---------------------------------------------------

// PosTTL keeps a position across a reconnect (§5: sliding ~30 m).
const PosTTL = 30 * time.Minute

// SetPos stores the last-known position JSON.
func (c *Client) SetPos(ctx context.Context, channelID, userID string, value []byte) error {
	return c.set(ctx, c.Key("pos", channelID, userID), value, PosTTL)
}

// SetPosBatch stores many positions of one channel in a single round trip
// (the lobby flush persists at most once a second, all movers at once).
func (c *Client) SetPosBatch(ctx context.Context, channelID string, values map[string][]byte) error {
	if len(values) == 0 {
		return nil
	}
	return c.tx(ctx, func(pipe redis.Pipeliner) {
		for userID, v := range values {
			pipe.Set(ctx, c.Key("pos", channelID, userID), v, PosTTL)
		}
	})
}

// tx runs one transactional pipeline and wraps its error the way every write
// helper reports Redis trouble: `redis: <sanitized cause>`.
func (c *Client) tx(ctx context.Context, fill func(pipe redis.Pipeliner)) error {
	pipe := c.rdb.TxPipeline()
	fill(pipe)
	if _, err := pipe.Exec(ctx); err != nil {
		return fmt.Errorf("redis: %w", sanitize(err))
	}
	return nil
}

// GetPos returns the retained position, or nil.
func (c *Client) GetPos(ctx context.Context, channelID, userID string) ([]byte, error) {
	return c.get(ctx, c.Key("pos", channelID, userID))
}

// DelPos forgets a position (explicit leave).
func (c *Client) DelPos(ctx context.Context, channelID, userID string) error {
	return c.del(ctx, c.Key("pos", channelID, userID))
}

// --- party ---------------------------------------------------------------

// PartyTTL is the roster's sliding lifetime (§5: ~30 m). A party survives a
// reconnect but not a logout; `partyOf` shares the TTL so it never outlives
// the roster.
const PartyTTL = 30 * time.Minute

// SetParty writes the roster and every member's reverse index atomically.
func (c *Client) SetParty(ctx context.Context, channelID, partyID string, roster []byte, memberIDs []string) error {
	return c.tx(ctx, func(pipe redis.Pipeliner) {
		pipe.Set(ctx, c.Key("party", channelID, partyID), roster, PartyTTL)
		for _, m := range memberIDs {
			pipe.Set(ctx, c.Key("partyOf", channelID, m), partyID, PartyTTL)
		}
	})
}

// DelParty removes the roster and the reverse index of the given members.
func (c *Client) DelParty(ctx context.Context, channelID, partyID string, memberIDs []string) error {
	return c.tx(ctx, func(pipe redis.Pipeliner) {
		pipe.Del(ctx, c.Key("party", channelID, partyID))
		for _, m := range memberIDs {
			pipe.Del(ctx, c.Key("partyOf", channelID, m))
		}
	})
}

// DelPartyOf drops one member's reverse index (they left; the roster stays).
func (c *Client) DelPartyOf(ctx context.Context, channelID, userID string) error {
	return c.del(ctx, c.Key("partyOf", channelID, userID))
}

// GetParty returns the roster JSON or nil.
func (c *Client) GetParty(ctx context.Context, channelID, partyID string) ([]byte, error) {
	return c.get(ctx, c.Key("party", channelID, partyID))
}

// PartyOf returns the party id a user belongs to, or "".
func (c *Client) PartyOf(ctx context.Context, channelID, userID string) (string, error) {
	b, err := c.get(ctx, c.Key("partyOf", channelID, userID))
	return string(b), err
}

// --- actor bridge (`q`) --------------------------------------------------

// QueueTTL is the backstop for a queue nobody drains when the gateway itself
// dies (§2.5): dungeon lifetime plus margin.
const QueueTTL = 15 * time.Minute

// GetRaw reads an unprefixed key (the start event lives under the console's
// derived `game:` prefix).
func (c *Client) GetRaw(ctx context.Context, key string) ([]byte, error) {
	return c.get(ctx, key)
}

// GetRawMany reads several unprefixed keys in one round trip; a missing key
// is a nil entry.
func (c *Client) GetRawMany(ctx context.Context, keys ...string) ([][]byte, error) {
	if len(keys) == 0 {
		return nil, nil
	}
	vals, err := c.rdb.MGet(ctx, keys...).Result()
	if err != nil {
		return nil, fmt.Errorf("redis: %w", sanitize(err))
	}
	out := make([][]byte, len(vals))
	for i, v := range vals {
		if s, ok := v.(string); ok {
			out[i] = []byte(s)
		}
	}
	return out, nil
}

// Push RPUSHes an envelope to an unprefixed queue key, re-applies the TTL and
// returns the new depth. Depth is free here (`RPUSH` replies with it), which
// is what makes actor-death detection cheap.
func (c *Client) Push(ctx context.Context, key string, payload []byte) (int64, error) {
	var push *redis.IntCmd
	if err := c.tx(ctx, func(pipe redis.Pipeliner) {
		push = pipe.RPush(ctx, key, payload)
		pipe.Expire(ctx, key, QueueTTL)
	}); err != nil {
		return 0, err
	}
	return push.Val(), nil
}

// DelRaw deletes an unprefixed key (abort: drop the dead actor's queue).
func (c *Client) DelRaw(ctx context.Context, key string) error {
	return c.del(ctx, key)
}

// Subscribe opens a pub/sub subscription on the given (unprefixed) channels.
func (c *Client) Subscribe(ctx context.Context, channels ...string) *redis.PubSub {
	return c.rdb.Subscribe(ctx, channels...)
}

// --- helpers -------------------------------------------------------------

func (c *Client) set(ctx context.Context, key string, value []byte, ttl time.Duration) error {
	if err := c.rdb.Set(ctx, key, value, ttl).Err(); err != nil {
		return fmt.Errorf("redis: %w", sanitize(err))
	}
	return nil
}

func (c *Client) get(ctx context.Context, key string) ([]byte, error) {
	b, err := c.rdb.Get(ctx, key).Bytes()
	if errors.Is(err, redis.Nil) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("redis: %w", sanitize(err))
	}
	return b, nil
}

func (c *Client) del(ctx context.Context, key string) error {
	if err := c.rdb.Del(ctx, key).Err(); err != nil {
		return fmt.Errorf("redis: %w", sanitize(err))
	}
	return nil
}

// Sanitize is `sanitize` for callers that hold a raw go-redis object (the
// pub/sub subscription from `Subscribe` yields unsanitized dial errors).
func Sanitize(err error) error { return sanitize(err) }

// hostPort matches `host:port` / `[v6]:port` in free text. go-redis formats
// its own log lines ("connection pool: failed to dial …: dial tcp H:P …",
// "pubsub: reconnecting to new endpoint H:P") before handing them to the
// logger, so those need text-level masking. A key fragment such as
// `queue:1234` may match too; that is harmless.
var hostPort = regexp.MustCompile(`(?:\[[0-9a-fA-F:.]+\]|[A-Za-z0-9.-]+):[0-9]{1,5}\b`)

// MaskAddresses replaces every `host:port` in a formatted log line.
func MaskAddresses(s string) string { return hostPort.ReplaceAllString(s, "<addr>") }

// sanitize keeps driver errors free of infra identifiers. go-redis never
// includes the password in an error, but a dial/read error is a `*net.OpError`
// whose text names host:port, and a resolver error names the host: this is a
// public repository whose logs are reviewed in the open (`rules/security.md`),
// so the address is replaced by the operation and the error kind. Server
// replies (`NOPERM`, `WRONGTYPE`, …) and pool/context errors carry no address
// and pass through. The original error stays reachable through `Unwrap`, so
// `errors.Is(err, context.DeadlineExceeded)` still works; only the message
// changes. Out of scope: `rediss://` certificate errors (`x509.HostnameError`)
// are not `*net.OpError` and would name the host — the gateway connects over
// `redis://` to the same box today.
func sanitize(err error) error {
	var opErr *net.OpError
	if !errors.As(err, &opErr) {
		return err
	}
	kind := "network error"
	var dnsErr *net.DNSError
	switch {
	case errors.As(opErr.Err, &dnsErr):
		kind = "lookup: " + dnsErr.Err
	case opErr.Timeout():
		kind = "i/o timeout"
	case opErr.Err != nil:
		kind = opErr.Err.Error()
	}
	return &maskedError{msg: opErr.Op + " " + opErr.Net + ": " + kind, cause: err}
}

// maskedError replaces a driver error's text while keeping its chain.
type maskedError struct {
	msg   string
	cause error
}

func (e *maskedError) Error() string { return e.msg }
func (e *maskedError) Unwrap() error { return e.cause }
