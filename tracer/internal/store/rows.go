package store

// Row types the writer stores. normalize builds them from envelope items;
// empty strings are written as NULL.

// Event is an `event` or `feedback` item.
type Event struct {
	EventID           string
	Type              string
	TsMs              int64
	Level             string
	Platform          string
	Release           string
	Dist              string
	Environment       string
	TraceID           string
	UserID            string
	Device            string
	OS                string
	GroupKey          string
	Title             string
	Message           string
	ExceptionType     string
	ExceptionValue    string
	AssociatedEventID string
	JSON              []byte
	Tags              [][2]string
	Breadcrumbs       []Breadcrumb
}

// Breadcrumb belongs to the event it arrived in. TsMs 0 = unknown.
type Breadcrumb struct {
	TsMs     int64
	Type     string
	Category string
	Level    string
	Message  string
	DataJSON []byte
}

// Log is one entry of a `log` container.
type Log struct {
	TsMs           int64
	Level          string
	Body           string
	TraceID        string
	SpanID         string
	Release        string
	Environment    string
	UserID         string
	Device         string
	AttributesJSON []byte
	DedupeKey      []byte
}

// Transaction is a `transaction` item.
type Transaction struct {
	EventID     string
	TraceID     string
	Name        string
	Op          string
	Status      string
	StartMs     int64
	EndMs       int64
	Release     string
	Environment string
	Device      string
	JSON        []byte
}

// Session is one `session` update.
type Session struct {
	SID         string
	DID         string
	Status      string
	Errors      int64
	Seq         int64
	StartedMs   int64
	UpdatedMs   int64
	Release     string
	Environment string
}

// Attachment is a blob already written and fsynced under the blob root.
type Attachment struct {
	EventID        string
	BlobID         string
	Path           string // relative to the blob root
	AbsPath        string // removed again when the row turns out a duplicate
	Filename       string
	ContentType    string
	AttachmentType string
	Size           int64
	SHA256         string
}

// Drop counts items discarded or refused.
type Drop struct {
	ItemType string
	Reason   string
	Count    int64
	Bytes    int64
}

// Drop reasons (docs/tracer.md _Ingest_, _Limits_).
const (
	ReasonNotStored       = "not_stored"
	ReasonUnknown         = "unknown"
	ReasonInvalid         = "invalid"
	ReasonTooLarge        = "too_large"
	ReasonQuotaAttachment = "quota_attachment"
	ReasonQuotaRefused    = "quota_refused"
	ReasonDisk            = "disk"
	ReasonSlow            = "slow" // body slower than the ingest pacing (ingest.DefaultBody*)
)

// Rows is the number of rows a batch writes (the writer's grouping budget).
func (b *Batch) Rows() int {
	n := len(b.Events) + len(b.Logs) + len(b.Transactions) + len(b.Sessions) + len(b.Attachments) + len(b.Drops)
	for _, e := range b.Events {
		n += len(e.Tags) + len(e.Breadcrumbs)
	}
	return n
}

// Batch is everything one envelope adds, committed in one transaction.
type Batch struct {
	ResourceID   string
	Day          string // UTC YYYY-MM-DD of ReceivedMs
	ReceivedMs   int64
	Events       []Event
	Logs         []Log
	Transactions []Transaction
	Sessions     []Session
	Attachments  []Attachment
	Drops        []Drop
	// Bytes is added to daily_bytes (stored bytes), less DuplicateBytes.
	Bytes int64
	// AttachmentOverhead is charged per attachment row inside Bytes.
	AttachmentOverhead int64
	// QuotaHitMs, when set, records the day's first quota crossing.
	QuotaHitMs int64
}

// Result reports what a batch did not add.
type Result struct {
	DuplicateEvents int
	// DuplicateRows counts every ignored row: events, transactions, logs, attachments.
	DuplicateRows int
	// DuplicateBytes is what duplicate attachments would have added (size +
	// AttachmentOverhead); it is not charged to daily_bytes.
	DuplicateBytes int64
	// RemovedBlobs are attachment files deleted because their row was a duplicate.
	RemovedBlobs int
	dupBlobs     []string
}
