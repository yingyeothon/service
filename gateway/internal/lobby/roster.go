package lobby

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/yingyeothon/service/gateway/internal/redisx"
)

// ErrPartyNotFound is "no such party, or the caller is not in it" — one error for
// both so a party id cannot be probed from outside.
var ErrPartyNotFound = errors.New("party not found")

// ReadRoster loads a party's roster from Redis for the game's HTTP API. It is
// answered only to a member of that party (`userID`), which is what lets a
// game trust the roster its entry API receives without trusting the client
// that named the party (`gateway/README.md`, "Party roster for games").
// Online is derived from the lobby session keys, so it is correct across a
// gateway restart too.
func ReadRoster(ctx context.Context, rdb *redisx.Client, channelID, partyID, userID string) (Roster, error) {
	if partyID == "" || !ValidPartyID(partyID) {
		return Roster{}, ErrPartyNotFound
	}
	b, err := rdb.GetParty(ctx, channelID, partyID)
	if err != nil {
		return Roster{}, fmt.Errorf("get party: %w", err)
	}
	if b == nil {
		return Roster{}, ErrPartyNotFound
	}
	var r rosterJSON
	if json.Unmarshal(b, &r) != nil || r.ID != partyID || len(r.Members) == 0 {
		return Roster{}, ErrPartyNotFound
	}
	member := false
	for _, m := range r.Members {
		if m == userID {
			member = true
			break
		}
	}
	if !member {
		return Roster{}, ErrPartyNotFound
	}
	// No `invited`: pending invitees are not the game's business, and the
	// socket roster already tells the members who asked whom.
	out := Roster{Type: "party", PartyID: r.ID, LeaderID: r.LeaderID, Members: make([]Member, 0, len(r.Members))}
	keys := make([]string, len(r.Members))
	for i, m := range r.Members {
		keys[i] = rdb.SessionKey("lobby", channelID, m)
	}
	conns, err := rdb.GetRawMany(ctx, keys...)
	if err != nil {
		return Roster{}, fmt.Errorf("get sessions: %w", err)
	}
	for i, m := range r.Members {
		out.Members = append(out.Members, Member{UserID: m, Online: conns[i] != nil})
	}
	return out, nil
}
