package lobby

import "encoding/json"

// Inbound is the union of every client frame the lobby accepts. Unknown
// fields are ignored; unknown types are refused with `bad_message`.
type Inbound struct {
	Type    string          `json:"type"`
	Zone    string          `json:"zone"`
	X       *float64        `json:"x"`
	Y       *float64        `json:"y"`
	Dir     string          `json:"dir"`
	Scope   string          `json:"scope"`
	To      string          `json:"to"`
	Text    string          `json:"text"`
	UserID  string          `json:"userId"`
	PartyID string          `json:"partyId"`
	Name    string          `json:"name"`
	Payload json.RawMessage `json:"payload"`
}

// Hello is the first frame (`todo/14` §2.3, settled 2026-08-25). The client
// holds no configuration and learns everything here.
type Hello struct {
	Type         string       `json:"type"`
	UserID       string       `json:"userId"`
	ConnectionID string       `json:"connectionId"`
	Tick         int          `json:"tick"`
	MapURL       string       `json:"mapUrl"`
	Capabilities Capabilities `json:"capabilities"`
	Zone         string       `json:"zone"`
	// PartyID is set when a reconnecting player still belongs to a party.
	PartyID string `json:"partyId,omitempty"`
	// AOI is the channel's view rule: `maxPeers` always (the nearest that
	// many peers are in view), `range` only when the channel has a box.
	AOI *AOI `json:"aoi"`
}

// AOI is the `hello` form of the channel's view rule.
type AOI struct {
	Range    float64 `json:"range,omitempty"`
	MaxPeers int     `json:"maxPeers"`
}

// Capabilities is the `hello` form: the config object verbatim, so the
// client can render exactly the UI this channel enables.
type Capabilities struct {
	Pos   bool     `json:"pos"`
	Say   []string `json:"say"`
	Party bool     `json:"party"`
	Event bool     `json:"event"`
	Debug bool     `json:"debug"`
}

// Peer is one retained position.
type Peer struct {
	UserID string  `json:"userId"`
	X      float64 `json:"x"`
	Y      float64 `json:"y"`
	Dir    string  `json:"dir,omitempty"`
}

// Snapshot lists everyone in view of the client that just entered a zone:
// the whole zone, or the AOI box when the channel filters.
type Snapshot struct {
	Type  string `json:"type"`
	Zone  string `json:"zone"`
	Peers []Peer `json:"peers"`
}

// Enter/Leave are gateway-synthesised: a peer came into, or went out of,
// the receiver's view (zone-wide without AOI, the box with it).
type Enter struct {
	Type string `json:"type"`
	Zone string `json:"zone"`
	Peer
}

type Leave struct {
	Type   string `json:"type"`
	Zone   string `json:"zone"`
	UserID string `json:"userId"`
}

// PosBatch is one coalesced frame per flush interval with every peer in
// view (you included) that moved since the last one.
type PosBatch struct {
	Type  string `json:"type"`
	Zone  string `json:"zone"`
	Peers []Peer `json:"peers"`
}

// Say is chat mirrored to its scope.
type Say struct {
	Type  string `json:"type"`
	From  string `json:"from"`
	Scope string `json:"scope"`
	To    string `json:"to,omitempty"`
	Text  string `json:"text"`
}

// Event is the opaque game-defined relay; Payload is forwarded unread.
type Event struct {
	Type    string          `json:"type"`
	From    string          `json:"from"`
	Scope   string          `json:"scope"`
	To      string          `json:"to,omitempty"`
	Name    string          `json:"name"`
	Payload json.RawMessage `json:"payload,omitempty"`
}

// Roster is the party snapshot sent on every change. `PartyID` empty means
// "you are in no party" (sent after leave/dissolve).
type Roster struct {
	Type     string   `json:"type"`
	PartyID  string   `json:"partyId"`
	LeaderID string   `json:"leaderId,omitempty"`
	Members  []Member `json:"members"`
	Invited  []string `json:"invited,omitempty"`
	Max      int      `json:"max,omitempty"`
}

// Member is a roster entry; Online lets a client grey out a member whose
// socket dropped while the party waits for their reconnect.
type Member struct {
	UserID string `json:"userId"`
	Online bool   `json:"online"`
}

// Invite is delivered to the invitee.
type Invite struct {
	Type    string `json:"type"`
	PartyID string `json:"partyId"`
	From    string `json:"from"`
}

// Declined tells the leader an invite was refused.
type Declined struct {
	Type    string `json:"type"`
	PartyID string `json:"partyId"`
	UserID  string `json:"userId"`
}

// Pong answers an application-level ping.
type Pong struct {
	Type string `json:"type"`
}

// Frame type names, in one place.
const (
	THello    = "hello"
	TSnapshot = "snapshot"
	TEnter    = "enter"
	TLeave    = "leave"
	TPos      = "pos"
	TSay      = "say"
	TEvent    = "event"
	TParty    = "party"
	TInvite   = "party.invite"
	TDeclined = "party.declined"
	TPong     = "pong"
)

// Error codes.
const (
	ErrBadMessage    = "bad_message"
	ErrCapabilityOff = "capability_off"
	ErrRateLimited   = "rate_limited"
	ErrBadScope      = "bad_scope"
	ErrBadZone       = "bad_zone"
	ErrMoveTooFar    = "move_too_far"
	ErrUnknownUser   = "unknown_user"
	ErrNoParty       = "no_party"
	ErrInParty       = "already_in_party"
	ErrPartyFull     = "party_full"
	ErrNotInvited    = "not_invited"
	ErrUnknownParty  = "unknown_party"
	ErrNotLeader     = "not_leader"
	ErrTooLong       = "too_long"
)
