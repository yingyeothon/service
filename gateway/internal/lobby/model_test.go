package lobby

import (
	"context"
	"fmt"
	"math/rand"
	"sort"
	"sync"
	"testing"

	"github.com/yingyeothon/service/gateway/internal/console"
)

// viewOf is the hub's own view of a live socket, for comparing with what
// its recorder was told.
func (h *Hub) viewOf(connID string) (map[string]struct{}, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	cl, ok := h.conns[connID]
	if !ok {
		return nil, false
	}
	out := make(map[string]struct{}, len(cl.visible))
	for id := range cl.visible {
		out[id] = struct{}{}
	}
	return out, true
}

func keys(m map[string]struct{}) string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return fmt.Sprint(out)
}

// TestViewInvariantRandomized drives one goroutine per simulated player
// (join, replace, leave, move, zone change, zone chat) against a driver
// that flushes and reconfigures, under -race, and lets every recorder's
// checker judge the frames. At the end each live socket's hub-side view
// must equal what its client was told. Views are recomputed, capped and
// boxed along the way, so the model covers every rule at once.
func TestViewInvariantRandomized(t *testing.T) {
	const users, zones, steps = 12, 3, 400
	for _, seed := range []int64{1, 2, 3} {
		t.Run(fmt.Sprintf("seed%d", seed), func(t *testing.T) {
			c := cfg()
			c.FlushIntervalMs = 60_000
			c.MaxPeers = 4
			h, _, _ := newHub(t, c)
			ctx := context.Background()
			// Each player is driven by one goroutine and read again only
			// after wg.Wait(), so it needs no lock of its own.
			type player struct {
				conn   string
				sock   *rec
				zone   string
				x, y   float64
				joined bool
			}
			players := make([]*player, users)
			for i := range players {
				players[i] = &player{}
			}
			var wg sync.WaitGroup
			for i := range players {
				wg.Add(1)
				go func(i int, p *player) {
					defer wg.Done()
					r := rand.New(rand.NewSource(seed*100 + int64(i)))
					user := fmt.Sprintf("u%02d", i)
					n := 0
					join := func() {
						n++
						p.conn = fmt.Sprintf("i:%s:%d", user, n)
						p.sock = newRec(t)
						p.joined = true
						h.Join(ctx, p.conn, user, p.sock)
					}
					for s := 0; s < steps; s++ {
						if !p.joined {
							join()
							continue
						}
						switch k := r.Intn(20); {
						case k == 0:
							h.Leave(ctx, p.conn)
							p.joined = false
						case k == 1:
							join() // replace: the old socket is closed 4000
						case k == 2:
							// A zone change may land anywhere; the same zone
							// would be a teleport and be refused.
							next := fmt.Sprintf("Z%d", r.Intn(zones))
							for next == p.zone {
								next = fmt.Sprintf("Z%d", r.Intn(zones))
							}
							p.zone = next
							p.x, p.y = float64(r.Intn(12)), float64(r.Intn(12))
							send(h, p.conn, map[string]any{"type": "pos", "zone": p.zone, "x": p.x, "y": p.y})
						case k == 3:
							send(h, p.conn, map[string]any{"type": "say", "scope": "zone", "text": "hi"})
						default:
							if p.zone == "" {
								p.zone = "Z0"
							}
							p.x += float64(r.Intn(7) - 3)
							p.y += float64(r.Intn(7) - 3)
							send(h, p.conn, map[string]any{"type": "pos", "zone": p.zone, "x": p.x, "y": p.y})
						}
					}
				}(i, players[i])
			}
			wg.Add(1)
			go func() {
				defer wg.Done()
				r := rand.New(rand.NewSource(seed))
				for s := 0; s < steps; s++ {
					switch r.Intn(6) {
					case 0:
						next := c
						if r.Intn(2) == 0 {
							next.AOI = &console.LobbyAOI{Range: float64(2 + r.Intn(4))}
						}
						next.MaxPeers = 2 + r.Intn(5)
						h.Reconfigure(next)
					default:
						h.Flush(ctx)
					}
				}
			}()
			wg.Wait()
			h.Flush(ctx)
			live := 0
			for _, p := range players {
				if !p.joined {
					continue
				}
				hubView, ok := h.viewOf(p.conn)
				if !ok {
					t.Errorf("%s: joined but not on the hub", p.conn)
					continue
				}
				live++
				if got, want := keys(p.sock.seen()), keys(hubView); got != want {
					t.Errorf("%s: client was told %s, hub holds %s", p.conn, got, want)
				}
				if p.sock.find("error") != nil {
					t.Errorf("%s: the model must never be refused: %v", p.conn, p.sock.find("error"))
				}
			}
			if live == 0 {
				t.Fatal("model ended with nobody online; widen the steps")
			}
		})
	}
}
