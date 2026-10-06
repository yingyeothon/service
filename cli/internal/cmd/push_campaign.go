package cmd

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/csv"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/spf13/cobra"
	"github.com/yingyeothon/service/cli/internal/api"
	"github.com/yingyeothon/service/cli/internal/output"
)

// Push campaigns (docs/push.md "Campaigns"): templates, recipient CSVs, jobs,
// reports and the broadcast, on the member family `/channels/{id}/push/…`.
//
// The same job routes exist under `/push-api/{channelId}/…` for the channel
// apiKey. This CLI holds a console token only and calls no route with a
// channel apiKey (see push.go), so that family is a game server's. There an
// unknown channel id answers the 401 of a wrong key, not a 404.

const (
	// pushCSVMaxBytes mirrors `PUSH_CSV_MAX_BYTES`: the hard
	// push.recipientsPerJob plus a header, at 1,024 bytes a record.
	pushCSVMaxBytes = 102_401_024
	// The header is one record of at most 1,024 bytes; this much holds it,
	// a byte-order mark and the line break.
	pushCSVHeaderRead = 4096
	pushCSVColumnsMax = 32
	pushCSVUserColumn = "userId"
)

// pushJobPoll is how often `--wait` reads a job. A read takes no write slot.
var pushJobPoll = 3 * time.Second

// pushNow is the clock of the broadcast's derived key; tests pin it.
var pushNow = time.Now

var (
	pushVarName = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]{0,31}$`)
	// The two shapes `isTokenColumn` refuses on the server, compared
	// without case and underscores.
	pushTokenColumn = regexp.MustCompile(`^(?:(?:fcm|device|registration|push|firebase|instance)?tokens?|(?:registration|instance)ids?)$`)
	pushJobID       = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)
	pushIdemKey     = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$`)
)

// pushTemplate mirrors console's `templateView`.
type pushTemplate struct {
	ID             string            `json:"id"`
	ChannelID      string            `json:"channelId"`
	Name           string            `json:"name"`
	Title          string            `json:"title"`
	Body           string            `json:"body"`
	Data           map[string]string `json:"data"`
	Variables      []string          `json:"variables"`
	CreatedBy      string            `json:"createdBy"`
	CreatedByLogin *string           `json:"createdByLogin"`
	UpdatedBy      string            `json:"updatedBy"`
	UpdatedByLogin *string           `json:"updatedByLogin"`
	CreatedAt      int64             `json:"createdAt"`
	UpdatedAt      int64             `json:"updatedAt"`
}

// pushJob mirrors console's `jobView`. Counts are per CSV row (user), not
// per device; for a broadcast they count Firebase projects.
type pushJob struct {
	ID        string  `json:"id"`
	ChannelID string  `json:"channelId"`
	Kind      string  `json:"kind"`
	DryRun    bool    `json:"dryRun"`
	Status    string  `json:"status"`
	Error     *string `json:"error"`
	// null unless Status is "failed".
	ErrorDetails    json.RawMessage `json:"errorDetails"`
	CancelRequested bool            `json:"cancelRequested"`
	IdempotencyKey  string          `json:"idempotencyKey"`
	TemplateID      *string         `json:"templateId"`
	UploadID        *string         `json:"uploadId"`
	Message         struct {
		Title string            `json:"title"`
		Body  string            `json:"body"`
		Data  map[string]string `json:"data"`
	} `json:"message"`
	Options   json.RawMessage `json:"options"`
	Author    string          `json:"author"`
	Total     *int64          `json:"total"`
	Processed int64           `json:"processed"`
	Counts    struct {
		Resolved         int64 `json:"resolved"`
		Sent             int64 `json:"sent"`
		NoToken          int64 `json:"noToken"`
		Unregistered     int64 `json:"unregistered"`
		Failed           int64 `json:"failed"`
		Skipped          int64 `json:"skipped"`
		Duplicates       int64 `json:"duplicates"`
		MissingVariables int64 `json:"missingVariables"`
		Invalid          int64 `json:"invalid"`
	} `json:"counts"`
	Report *struct {
		Available bool  `json:"available"`
		ExpiresAt int64 `json:"expiresAt"`
	} `json:"report"`
	CreatedAt  int64  `json:"createdAt"`
	StartedAt  *int64 `json:"startedAt"`
	FinishedAt *int64 `json:"finishedAt"`
}

func (j pushJob) finished() bool { return j.Status == "done" || j.Status == "failed" }

type pushJobAnswer struct {
	Job     pushJob `json:"job"`
	Created bool    `json:"created"`
}

/* ---------------- refusals ---------------- */

// pushCSVReasons words a CSV rule (`CsvFailure` on the server, plus the two
// only the worker reports).
var pushCSVReasons = map[string]string{
	"empty":               "the file holds no header",
	"invalid_utf8":        "not valid UTF-8",
	"nul_byte":            "a NUL byte",
	"bare_cr":             "a CR without an LF; save with LF or CRLF line ends",
	"quote":               "a quote inside an unquoted field, or text after a closing quote; quote the whole field and double the quotes inside it",
	"unterminated_quote":  "a quoted field is never closed",
	"row_too_long":        "a record is longer than 1,024 bytes",
	"field_too_long":      "a field is longer than 512 bytes",
	"too_many_columns":    "more than 32 columns",
	"column_count":        "the row does not have as many fields as the header",
	"header_name":         "a column name is not a variable name ([A-Za-z_][A-Za-z0-9_]{0,31})",
	"duplicate_header":    "a column name appears twice",
	"user_column_missing": "no userId column (spelled exactly so)",
	"token_column":        "a column reads like a device token; recipients are named by userId only",
	"no_rows":             "a header and no rows",
	"missing_columns":     "a column the template names is missing",
}

// pushCSVProblem is "line N: <rule>" for a CSV refusal.
func pushCSVProblem(reason string, line int64) string {
	what, ok := pushCSVReasons[reason]
	if !ok {
		what = reason
	}
	if line > 0 {
		return fmt.Sprintf("CSV line %d: %s", line, what)
	}
	return "CSV: " + what
}

// pushCampaignHints says what to do about a campaign route's `details.reason`.
var pushCampaignHints = map[string]string{
	"template_has_variables":   "a broadcast has no row to fill a {{variable}} from; use a template without variables or literal text",
	"push_payload_too_large":   "the message's literal text alone is over 4,096 bytes; shorten it",
	"push_template_name_taken": "another template of the channel has that name (names ignore case)",
	"push_template_cap":        "a channel holds 20 templates; remove one with `yyt push template rm`",
	"idempotency_key_reused":   "the key names an earlier job with another template, file, --dry-run or option; pass a new --idempotency-key to submit this one",
	"upload_missing":           "nothing reached the upload's URL; run the command again",
	"upload_size_mismatch":     "the uploaded object is not of the signed size; run the command again",
	"upload_expired":           "the upload is older than 24 hours; run the command again to upload the file anew",
	"push_upload_cap":          "the channel holds its 20 pending uploads; one stops counting when its jobs have finished and an unused one is removed two days after it was made, so wait for the oldest",
	"push_not_registered":      "the channel has neither a finished platform registration nor a team sender key: check `registered` in `yyt push channel get`, or add a key with `yyt push channel sender-key set` (a --dry-run needs neither)",
	"push_not_configured":      "this stage has no push sender yet; a platform admin provisions it (a --dry-run is still accepted)",
	"report_not_ready":         "the job has not finished; follow it with `yyt push job get`",
	"report_absent":            "the job ended before its first batch, or is a broadcast: there is nothing to report",
}

// withCampaignHint adds the next step to a campaign refusal. channelID names
// the scope of the limit request a `push.jobsPerDay` refusal asks for.
func withCampaignHint(err error, channelID string) error {
	var ae *api.Error
	if !errors.As(err, &ae) {
		return err
	}
	var d struct {
		Reason  string   `json:"reason"`
		CSV     string   `json:"csv"`
		Line    int64    `json:"line"`
		Columns []string `json:"columns"`
		Max     int64    `json:"max"`
	}
	_ = json.Unmarshal(ae.Details, &d)
	// The four below carry a reason; an answer without one (an older console)
	// is told by its status and message.
	gone := ae.Status == http.StatusGone && d.Reason == ""
	down := ae.Status == http.StatusServiceUnavailable && d.Reason == ""
	switch {
	case d.Reason == "csv_invalid":
		return fmt.Errorf("%w (%s)", err, pushCSVProblem(d.CSV, d.Line))
	case d.Reason == "csv_missing_columns":
		return fmt.Errorf("%w (the CSV needs a column for each of: %s)", err, output.Clean(strings.Join(d.Columns, ", ")))
	case ae.Status == http.StatusTooManyRequests:
		return fmt.Errorf("%w (the console takes two writes a second per member; run it again)", err)
	case d.Reason == "push_dry_run_cap":
		// The cap is the server's constant: named from its answer.
		if d.Max > 0 {
			return fmt.Errorf("%w (%d dry runs a day and channel; the count resets at 00:00 UTC)", err, d.Max)
		}
		return fmt.Errorf("%w (the channel ran its dry runs of the day; the count resets at 00:00 UTC)", err)
	case d.Reason == "report_expired", gone && strings.Contains(ae.Message, "report"):
		return fmt.Errorf("%w (a report is kept 7 days after its job finished)", err)
	case d.Reason == "channel_inactive", gone:
		return fmt.Errorf("%w (an expired or disabled channel submits nothing; `yyt push channel extend %s`)", err, channelID)
	case d.Reason == "push_sender_unavailable", down && strings.Contains(ae.Message, "sender"):
		return fmt.Errorf("%w (the stage no longer holds the channel's Firebase project; a platform admin's to fix)", err)
	case d.Reason == "push_storage_unavailable", down && strings.Contains(ae.Message, "storage"):
		return fmt.Errorf("%w (this stage has no storage for recipient files and reports; a platform admin provisions it)", err)
	case down:
		return fmt.Errorf("%w (the console could not serve this; try again shortly)", err)
	}
	return withPushHint(err, " --channel "+channelID, pushCampaignHints)
}

// pushReportLegend follows a downloaded report on stderr.
const pushReportLegend = "a skipped row's reason: duplicate, missing-variable, invalid-user, too-large or invalid-value (a value that would put a control character into the message); the last three are the job's `invalid` count"

// pushJobErrors says what a `job.error` means and what to do next.
var pushJobErrors = map[string]string{
	"canceled":           "cancelled; rows already sent stay sent and are in the report",
	"upload_missing":     "the uploaded file is gone; submit again",
	"upload_changed":     "the uploaded file was replaced after the submit; submit again",
	"channel_gone":       "the channel was deleted",
	"channel_inactive":   "the channel expired or was disabled; extend it and submit again with a new --idempotency-key",
	"not_registered":     "the channel lost its registration and holds no team sender key",
	"sender_unavailable": "FCM refused the platform's key, or the stage lost the channel's Firebase project; a platform admin's to fix",
	"send_failed":        "no Firebase project accepted the broadcast; try again with a new --idempotency-key",
	"stalled":            "five runs died without finishing it; the report holds the rows it reached",
	"expired":            "still unfinished three days after the submit",
}

// pushJobFailure words why a job failed, with the next step.
func pushJobFailure(j pushJob) string {
	if j.Error == nil {
		return ""
	}
	code := *j.Error
	var d struct {
		Reason string          `json:"reason"`
		Line   int64           `json:"line"`
		Limit  string          `json:"limit"`
		Value  json.RawMessage `json:"value"`
	}
	_ = json.Unmarshal(j.ErrorDetails, &d)
	switch code {
	case "csv_invalid":
		return code + " (" + pushCSVProblem(d.Reason, d.Line) + "; nothing was sent)"
	case "recipients_over_limit":
		limit := d.Limit
		if limit == "" {
			limit = "push.recipientsPerJob"
		}
		at := ""
		if len(d.Value) > 0 && string(d.Value) != "null" {
			at = " of " + string(d.Value)
		}
		return fmt.Sprintf("%s (more rows than the limit%s; nothing was sent. Split the file, or ask for more: yyt limit request %s <value> --channel %s --reason \"...\")", code, at, limit, j.ChannelID)
	}
	if hint, ok := pushJobErrors[code]; ok {
		return code + " (" + hint + ")"
	}
	return code
}

/* ---------------- helpers ---------------- */

func pushBase(channelID string) string { return "/channels/" + api.PathID(channelID) + "/push" }

// parsePushData reads repeated `--data key=value`; a value may be empty and
// may hold `=`.
func parsePushData(pairs []string) (map[string]string, error) {
	data := map[string]string{}
	for _, p := range pairs {
		k, v, ok := strings.Cut(p, "=")
		if !ok || k == "" {
			return nil, fmt.Errorf("invalid --data %q (want key=value)", p)
		}
		data[k] = v
	}
	return data, nil
}

// pushTemplateFileKeys are the fields of a template view a `--file` may
// carry without being sent, so `template get --json` output can be edited
// and fed back.
var pushTemplateFileKeys = map[string]bool{
	"id": true, "channelId": true, "variables": true,
	"createdBy": true, "createdByLogin": true, "updatedBy": true, "updatedByLogin": true,
	"createdAt": true, "updatedAt": true,
}

// readPushTemplateFile returns the `name`, `title`, `body` and `data` a JSON
// file gives. Any other key that is not a view field is refused: a misspelt
// `titel` must not be dropped silently.
func readPushTemplateFile(path string) (map[string]any, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("--file: %w", err)
	}
	var raw map[string]json.RawMessage
	if json.Unmarshal(bytes.TrimPrefix(b, []byte("\xef\xbb\xbf")), &raw) != nil || raw == nil {
		return nil, errors.New("--file: not a JSON object ({name, title, body, data})")
	}
	out := map[string]any{}
	for k, v := range raw {
		switch k {
		case "name", "title", "body":
			var s string
			if json.Unmarshal(v, &s) != nil {
				return nil, fmt.Errorf("--file: %s must be a string", k)
			}
			out[k] = s
		case "data":
			var m map[string]string
			if json.Unmarshal(v, &m) != nil || m == nil {
				return nil, errors.New("--file: data must be an object of strings")
			}
			out[k] = m
		default:
			if !pushTemplateFileKeys[k] {
				return nil, fmt.Errorf("--file: unknown field %q (want name, title, body, data)", k)
			}
		}
	}
	return out, nil
}

// pushTemplates lists a channel's templates.
func pushTemplates(ctx context.Context, cl *api.Client, channelID string) ([]pushTemplate, error) {
	var res struct {
		Templates []pushTemplate `json:"templates"`
	}
	if err := cl.Do(ctx, http.MethodGet, pushBase(channelID)+"/templates", nil, &res); err != nil {
		return nil, withCampaignHint(err, channelID)
	}
	return res.Templates, nil
}

// resolvePushTemplate finds a template by id, else by name without case. A
// template name may itself look like an id (`pt_…` is a valid name), so the
// channel's list (at most 20) is always what decides.
func resolvePushTemplate(ctx context.Context, cl *api.Client, channelID, arg string) (pushTemplate, error) {
	rows, err := pushTemplates(ctx, cl, channelID)
	if err != nil {
		return pushTemplate{}, err
	}
	for _, t := range rows {
		if t.ID == arg {
			return t, nil
		}
	}
	for _, t := range rows {
		if strings.EqualFold(t.Name, arg) {
			return t, nil
		}
	}
	return pushTemplate{}, &api.Error{Status: 404, Code: "not_found",
		Message: fmt.Sprintf("template %q not found in %s (yyt push template ls %s)", arg, channelID, channelID)}
}

func pushDataText(data map[string]string) string {
	if len(data) == 0 {
		return "-"
	}
	b, _ := json.Marshal(data) // keys sorted
	return string(b)
}

func (a *App) showPushTemplate(t pushTemplate) error {
	if a.jsonOut {
		return a.printer().JSONValue(t)
	}
	vars := "none"
	if len(t.Variables) > 0 {
		vars = strings.Join(t.Variables, ", ") + " (CSV columns beside userId)"
	}
	by := output.Str(t.UpdatedByLogin)
	if t.UpdatedByLogin == nil && t.UpdatedBy != "" {
		by = t.UpdatedBy
	}
	title := strconv.Quote(t.Title)
	if t.Title == "" {
		title += " (a data-only message)"
	}
	return a.printer().KV([][2]string{
		{"id", t.ID},
		{"name", t.Name},
		{"title", title},
		{"body", strconv.Quote(t.Body)},
		{"data", pushDataText(t.Data)},
		{"variables", vars},
		{"updated", output.Time(t.UpdatedAt) + " by " + by},
	})
}

func pushJobKind(j pushJob) string {
	if j.DryRun {
		return j.Kind + " (dry run)"
	}
	return j.Kind
}

func (a *App) showPushJob(j pushJob) error {
	if a.jsonOut {
		return a.printer().JSONValue(j)
	}
	status := j.Status
	switch {
	case j.CancelRequested && !j.finished():
		status += " (cancel requested)"
	case j.CancelRequested && j.Status == "done":
		// The cancel arrived during the last batch: every row was processed.
		status += " (finished before the cancel took effect)"
	}
	pairs := [][2]string{
		{"id", j.ID},
		{"kind", pushJobKind(j)},
		{"status", status},
	}
	if j.Error != nil {
		pairs = append(pairs, [2]string{"error", pushJobFailure(j)})
	}
	pairs = append(pairs,
		[2]string{"key", j.IdempotencyKey},
		[2]string{"template", output.Str(j.TemplateID)},
		[2]string{"title", strconv.Quote(j.Message.Title)},
		[2]string{"body", strconv.Quote(j.Message.Body)},
		[2]string{"data", pushDataText(j.Message.Data)},
	)
	if len(j.Options) > 0 && string(j.Options) != "{}" && string(j.Options) != "null" {
		pairs = append(pairs, [2]string{"options", string(j.Options)})
	}
	pairs = append(pairs,
		[2]string{"author", j.Author},
		[2]string{"created", output.Time(j.CreatedAt)},
		[2]string{"started", output.TimePtr(j.StartedAt)},
		[2]string{"finished", output.TimePtr(j.FinishedAt)},
	)
	n := func(v int64) string { return strconv.FormatInt(v, 10) }
	c := j.Counts
	switch {
	case j.Kind == "broadcast":
		// One message per Firebase project; FCM does not say how many
		// devices a topic reached.
		if j.Total != nil {
			pairs = append(pairs, [2]string{"projects", fmt.Sprintf("%d accepted of %d", c.Sent, *j.Total)})
		}
	default:
		total := "not counted yet"
		if j.Total != nil {
			total = fmt.Sprintf("%d of %d", j.Processed, *j.Total)
		}
		pairs = append(pairs, [2]string{"rows", total})
		if j.DryRun {
			pairs = append(pairs, [2]string{"resolved", n(c.Resolved) + " (users holding a token: a real job starts from these)"})
		} else {
			pairs = append(pairs, [2]string{"sent", n(c.Sent)})
		}
		pairs = append(pairs, [2]string{"noToken", n(c.NoToken)})
		if !j.DryRun {
			pairs = append(pairs, [2]string{"unregistered", n(c.Unregistered)}, [2]string{"failed", n(c.Failed)})
		}
		pairs = append(pairs, [2]string{"skipped", fmt.Sprintf("%d (duplicates %d, missing variables %d, invalid %d)", c.Skipped, c.Duplicates, c.MissingVariables, c.Invalid)})
		report := "none"
		switch {
		case j.Report != nil && j.Report.Available:
			report = fmt.Sprintf("until %s (yyt push job report %s %s)", output.Time(j.Report.ExpiresAt), j.ChannelID, j.ID)
		case j.Report != nil:
			report = "expired " + output.Time(j.Report.ExpiresAt)
		}
		pairs = append(pairs, [2]string{"report", report})
	}
	return a.printer().KV(pairs)
}

/* ---------------- recipient CSV ---------------- */

// pushCSVFile is what a submit needs of the local file.
type pushCSVFile struct {
	size    int64
	sha256  string
	columns []string
}

// inspectPushCSV reads the header as the server will and hashes the file. It
// refuses what the submit would refuse at line 1; rows are the worker's to
// judge. `encoding/csv` is not the server's reader, so a header it accepts
// can still be refused there (the server's verdict is the one that counts).
func inspectPushCSV(path string) (pushCSVFile, error) {
	var out pushCSVFile
	f, err := os.Open(path)
	if err != nil {
		return out, fmt.Errorf("--csv: %w", err)
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return out, fmt.Errorf("--csv: %w", err)
	}
	if st.IsDir() {
		return out, fmt.Errorf("--csv: %s is a directory", path)
	}
	out.size = st.Size()
	bad := func(reason string) error { return fmt.Errorf("%s: %s", path, pushCSVProblem(reason, 1)) }
	if out.size == 0 {
		return out, bad("empty")
	}
	if out.size > pushCSVMaxBytes {
		return out, fmt.Errorf("%s: %d bytes; a recipient CSV is at most %d", path, out.size, pushCSVMaxBytes)
	}
	h := sha256.New()
	head := make([]byte, pushCSVHeaderRead)
	n, err := io.ReadFull(io.TeeReader(f, h), head)
	if err != nil && !errors.Is(err, io.ErrUnexpectedEOF) && !errors.Is(err, io.EOF) {
		return out, fmt.Errorf("--csv: %w", err)
	}
	head = head[:n]
	if _, err := io.Copy(h, f); err != nil {
		return out, fmt.Errorf("--csv: %w", err)
	}
	out.sha256 = hex.EncodeToString(h.Sum(nil))

	r := csv.NewReader(bytes.NewReader(bytes.TrimPrefix(head, []byte("\xef\xbb\xbf"))))
	r.FieldsPerRecord = -1
	fields, err := r.Read()
	switch {
	case errors.Is(err, io.EOF):
		return out, bad("empty")
	case int64(n) < out.size && !bytes.Contains(head, []byte("\n")):
		// The header record did not end inside what was read.
		return out, bad("row_too_long")
	case err != nil:
		return out, bad("quote")
	case len(fields) > pushCSVColumnsMax:
		return out, bad("too_many_columns")
	}
	seen := map[string]bool{}
	for _, name := range fields {
		switch {
		case !pushVarName.MatchString(name):
			return out, bad("header_name")
		case seen[name]:
			return out, bad("duplicate_header")
		case pushTokenColumn.MatchString(strings.ReplaceAll(strings.ToLower(name), "_", "")):
			return out, bad("token_column")
		}
		seen[name] = true
	}
	if !seen[pushCSVUserColumn] {
		return out, bad("user_column_missing")
	}
	out.columns = fields
	return out, nil
}

/* ---------------- jobs ---------------- */

// pushJobOptions adds the targeted send's three options to a body.
type pushJobOptions struct {
	priority, collapseKey string
	ttl                   int
}

func (o *pushJobOptions) flags(c *cobra.Command) {
	c.Flags().StringVar(&o.priority, "priority", "", "high|normal (FCM's default when absent)")
	c.Flags().IntVar(&o.ttl, "ttl", 0, "seconds FCM keeps the message for an offline device (0 to 2419200)")
	c.Flags().StringVar(&o.collapseKey, "collapse-key", "", "FCM collapse key: a later message with the same key replaces an undelivered one")
}

func (o *pushJobOptions) apply(cmd *cobra.Command, body map[string]any) error {
	if o.priority != "" {
		if o.priority != "high" && o.priority != "normal" {
			return fmt.Errorf("--priority must be high|normal (got %q)", o.priority)
		}
		body["priority"] = o.priority
	}
	if cmd.Flags().Changed("ttl") {
		if o.ttl < 0 || o.ttl > 28*24*3600 {
			return fmt.Errorf("--ttl is 0 to %d seconds (got %d)", 28*24*3600, o.ttl)
		}
		body["ttlSec"] = o.ttl
	}
	if o.collapseKey != "" {
		body["collapseKey"] = o.collapseKey
	}
	return nil
}

// derivedPushKey is `cli-<40 hex>` over the parts, plus a suffix.
func derivedPushKey(suffix string, parts ...string) string {
	h := sha256.Sum256([]byte(strings.Join(parts, "\x00")))
	return "cli-" + hex.EncodeToString(h[:])[:40] + suffix
}

// heldPushJobs reads the job each given idempotency key holds, one
// `GET …/jobs?idempotencyKey=` per key. The server compares keys without
// case, so the answer is filed under the key as asked.
func heldPushJobs(ctx context.Context, cl *api.Client, channelID string, keys ...string) (map[string]pushJob, error) {
	found := map[string]pushJob{}
	for _, k := range keys {
		var res struct {
			Jobs []pushJob `json:"jobs"`
		}
		q := url.Values{"idempotencyKey": {k}}
		if err := cl.Do(ctx, http.MethodGet, pushBase(channelID)+"/jobs?"+q.Encode(), nil, &res); err != nil {
			return nil, withCampaignHint(err, channelID)
		}
		// Only the job of this key: an answer that is a page of the list (a
		// console without the lookup) must not be taken for it.
		for _, j := range res.Jobs {
			if strings.EqualFold(j.IdempotencyKey, k) {
				found[k] = j
				break
			}
		}
	}
	return found, nil
}

// uploadPushCSV creates an upload and PUTs the file to it. The URL is a
// temporary credential and is never printed.
func uploadPushCSV(ctx context.Context, cl *api.Client, channelID, path string, size int64) (string, error) {
	var grant uploadGrant
	// Not retried: the route takes no write slot, and after a failure the
	// upload row may exist — a channel holds 20 pending.
	if err := cl.Do(ctx, http.MethodPost, pushBase(channelID)+"/uploads", map[string]any{"size": size}, &grant); err != nil {
		return "", withCampaignHint(err, channelID)
	}
	if grant.UploadID == "" || grant.URL == "" {
		return "", errors.New("the console answered an upload without an id or a URL")
	}
	if grant.Method == "" {
		grant.Method = http.MethodPut
	}
	f, err := os.Open(path)
	if err != nil {
		return "", fmt.Errorf("--csv: %w", err)
	}
	defer f.Close()
	err = defaultRetry.do(ctx, func() error {
		if _, err := f.Seek(0, io.SeekStart); err != nil {
			return err
		}
		// NopCloser: the transport must not close the file between attempts.
		return putPresigned(ctx, cl, grant, io.NopCloser(f), size)
	})
	if err != nil {
		// Nothing can name it: the row would only hold a pending place.
		dropPushUpload(ctx, cl, channelID, grant.UploadID)
		return "", err
	}
	return grant.UploadID, nil
}

// dropPushUpload removes an upload no job names, best effort: one that is
// left is removed by the platform two days after it was made. The route
// takes the write slot, which the refused submit before it may still hold,
// so a 429 is retried.
func dropPushUpload(ctx context.Context, cl *api.Client, channelID, uploadID string) {
	_ = presignRetry.do(ctx, func() error {
		return cl.Do(ctx, http.MethodDelete, pushBase(channelID)+"/uploads/"+api.PathID(uploadID), nil, nil)
	})
}

// pushSubmitRefused reports an answer that recorded no job: a 4xx. After
// anything else (no answer, a 5xx) the job may exist and read the upload.
func pushSubmitRefused(err error) bool {
	var ae *api.Error
	return errors.As(err, &ae) && ae.Status >= 400 && ae.Status < 500
}

// pushUploadGone reports a refusal that only says the named upload cannot be
// used any more, which a fresh upload fixes.
func pushUploadGone(err error) bool {
	var ae *api.Error
	if !errors.As(err, &ae) {
		return false
	}
	if ae.Status == http.StatusNotFound {
		return strings.Contains(ae.Message, "upload")
	}
	var d struct {
		Reason string `json:"reason"`
	}
	_ = json.Unmarshal(ae.Details, &d)
	return d.Reason == "upload_expired" || d.Reason == "upload_missing" || d.Reason == "upload_size_mismatch"
}

// postPushJob submits a job or a broadcast. The idempotency key makes the
// call safe to repeat, so the write slot's 429 (two writes a second per
// member: another command's, or the refused reuse of an upload a moment
// before) is retried.
func postPushJob(ctx context.Context, cl *api.Client, path string, body map[string]any) (pushJobAnswer, error) {
	var res pushJobAnswer
	err := presignRetry.do(ctx, func() error {
		res = pushJobAnswer{}
		return cl.Do(ctx, http.MethodPost, path, body, &res)
	})
	return res, err
}

// waitPushJob polls a job until it is done or failed, or `timeout` passed.
// Progress goes to stderr, one line per change.
func (a *App) waitPushJob(ctx context.Context, cl *api.Client, j pushJob, timeout time.Duration) (pushJob, error) {
	path := pushBase(j.ChannelID) + "/jobs/" + api.PathID(j.ID)
	var waited time.Duration
	last := ""
	for !j.finished() {
		line := j.Status
		if j.Total != nil {
			line = fmt.Sprintf("%s %d/%d", j.Status, j.Processed, *j.Total)
		}
		if line != last {
			fmt.Fprintf(a.Err, "%s: %s\n", j.ID, output.Clean(line))
			last = line
		}
		if waited >= timeout {
			return j, fmt.Errorf("%s is still %s after %s; it keeps running: yyt push job get %s %s", j.ID, j.Status, timeout, j.ChannelID, j.ID)
		}
		if err := sleepFor(ctx, pushJobPoll); err != nil {
			return j, err
		}
		waited += pushJobPoll
		var res pushJobAnswer
		if err := defaultRetry.do(ctx, func() error {
			res = pushJobAnswer{}
			return cl.Do(ctx, http.MethodGet, path, nil, &res)
		}); err != nil {
			return j, withCampaignHint(err, j.ChannelID)
		}
		j = res.Job
	}
	return j, nil
}

// finishPushSubmit reports a submit's answer: what happened on stderr, the
// job on stdout, and with `wait` the job's end (an error when it failed).
func (a *App) finishPushSubmit(ctx context.Context, cl *api.Client, res pushJobAnswer, wait bool, timeout time.Duration) error {
	j := res.Job
	if res.Created {
		fmt.Fprintf(a.Err, "submitted %s %s\n", pushJobKind(j), j.ID)
	} else {
		fmt.Fprintf(a.Err, "replayed %s %s, submitted %s: nothing was submitted or sent again (pass a new --idempotency-key to run it again)\n",
			pushJobKind(j), j.ID, output.Time(j.CreatedAt))
	}
	if wait {
		var err error
		if j, err = a.waitPushJob(ctx, cl, j, timeout); err != nil {
			return err
		}
	} else if !j.finished() {
		fmt.Fprintf(a.Err, "follow it: yyt push job get %s %s (or submit with --wait)\n", j.ChannelID, j.ID)
	}
	if err := a.showPushJob(j); err != nil {
		return err
	}
	if wait && j.Status == "failed" {
		return fmt.Errorf("job %s failed: %s", j.ID, pushJobFailure(j))
	}
	return nil
}

/* ---------------- commands ---------------- */

// addPushCampaignCommands hangs `template`, `job` and `broadcast` on `yyt push`.
func (a *App) addPushCampaignCommands(push *cobra.Command, resolve channelResolver) {
	push.AddCommand(a.pushTemplateCmd(resolve), a.pushJobCmd(resolve), a.pushBroadcastCmd(resolve))
}

func (a *App) pushTemplateCmd(resolve channelResolver) *cobra.Command {
	c := &cobra.Command{
		Use:     "template",
		Aliases: []string{"templates"},
		Short:   "Message templates of a push channel (title, body, data with {{variables}})",
		Long: "Message templates of a push channel, at most 20 per channel.\n\n" +
			"A placeholder is {{name}} (name: [A-Za-z_][A-Za-z0-9_]{0,31}, no blanks) in the\n" +
			"title, the body and the values of data; a campaign fills it from the CSV\n" +
			"column of that name. An empty title makes a data-only message; a body needs\n" +
			"a title. <template> is an id (pt_…) or a name, compared without case.",
	}
	c.AddCommand(&cobra.Command{
		Use:     "ls <channel>",
		Aliases: []string{"list"},
		Short:   "List the channel's templates and the variables each names",
		Args:    cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cc, id, err := resolve(cmd, args[0], false)
			if err != nil {
				return err
			}
			var res struct {
				Templates []pushTemplate `json:"templates"`
				Max       int            `json:"max"`
			}
			if err := cc.cl.Do(cmd.Context(), http.MethodGet, pushBase(id)+"/templates", nil, &res); err != nil {
				return withCampaignHint(err, id)
			}
			if a.jsonOut {
				return a.printer().JSONValue(res)
			}
			rows := make([][]string, 0, len(res.Templates))
			for _, t := range res.Templates {
				vars := "-"
				if len(t.Variables) > 0 {
					vars = strings.Join(t.Variables, ",")
				}
				by := output.Str(t.UpdatedByLogin)
				if t.UpdatedByLogin == nil && t.UpdatedBy != "" {
					by = t.UpdatedBy
				}
				rows = append(rows, []string{t.Name, t.ID, vars, by, output.Time(t.UpdatedAt)})
			}
			return a.printer().Table([]string{"NAME", "ID", "VARIABLES", "UPDATED BY", "UPDATED"}, rows)
		},
	})
	c.AddCommand(&cobra.Command{
		Use:   "get <channel> <template>",
		Short: "Show a template and the variables it names (the CSV columns a job needs)",
		Args:  cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			cc, id, err := resolve(cmd, args[0], false)
			if err != nil {
				return err
			}
			t, err := resolvePushTemplate(cmd.Context(), cc.cl, id, args[1])
			if err != nil {
				return err
			}
			return a.showPushTemplate(t)
		},
	})

	var name, title, body, file string
	var data []string
	var clearData bool
	// messageBody builds a create/PATCH body: the file's fields, then the
	// flags that were given on top.
	messageBody := func(cmd *cobra.Command) (map[string]any, error) {
		out := map[string]any{}
		if file != "" {
			var err error
			if out, err = readPushTemplateFile(file); err != nil {
				return nil, err
			}
		}
		fl := cmd.Flags()
		if fl.Changed("name") {
			out["name"] = name
		}
		if fl.Changed("title") {
			out["title"] = title
		}
		if fl.Changed("body") {
			out["body"] = body
		}
		if fl.Changed("data") {
			m, err := parsePushData(data)
			if err != nil {
				return nil, err
			}
			out["data"] = m
		}
		return out, nil
	}
	messageFlags := func(cmd *cobra.Command, nameHelp string) {
		fl := cmd.Flags()
		fl.StringVar(&name, "name", "", nameHelp)
		fl.StringVar(&title, "title", "", "notification title, at most 1024 characters ('' = a data-only message)")
		fl.StringVar(&body, "body", "", "notification body, at most 4096 characters; needs a title")
		fl.StringArrayVar(&data, "data", nil, "data entry key=value (repeatable; the value may hold {{variables}}); the given set replaces the template's data")
		fl.StringVar(&file, "file", "", "a JSON file {name, title, body, data}; flags given beside it win")
	}
	create := &cobra.Command{
		Use:   "create <channel> --name <name> [--title … --body … --data k=v … | --file template.json]",
		Short: "Create a template",
		Example: "  yyt push template create alerts --name welcome --title \"Hi {{name}}\" --body \"Season 2 is open\" --data screen=season\n" +
			"  yyt push template create alerts --file welcome.json",
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			in, err := messageBody(cmd)
			if err != nil {
				return err
			}
			if s, _ := in["name"].(string); s == "" {
				return errors.New("a template needs a name: --name, or `name` in --file")
			}
			cc, id, err := resolve(cmd, args[0], true)
			if err != nil {
				return err
			}
			var t pushTemplate
			if err := cc.cl.Do(cmd.Context(), http.MethodPost, pushBase(id)+"/templates", in, &t); err != nil {
				return withCampaignHint(err, id)
			}
			return a.showPushTemplate(t)
		},
	}
	messageFlags(create, "template name: [A-Za-z0-9][A-Za-z0-9._-]{0,63}, unique in the channel without case")
	update := &cobra.Command{
		Use:   "update <channel> <template> [--name … --title … --body … --data k=v … | --file template.json]",
		Short: "Change a template; jobs already submitted keep the text they were submitted with",
		Args:  cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			in, err := messageBody(cmd)
			if err != nil {
				return err
			}
			if clearData {
				if _, given := in["data"]; given {
					return errors.New("--clear-data and data (--data, or `data` in --file) exclude each other")
				}
				in["data"] = map[string]string{}
			}
			if len(in) == 0 {
				return errors.New("nothing to change: pass --name, --title, --body, --data, --clear-data or --file")
			}
			cc, id, err := resolve(cmd, args[0], true)
			if err != nil {
				return err
			}
			cur, err := resolvePushTemplate(cmd.Context(), cc.cl, id, args[1])
			if err != nil {
				return err
			}
			var t pushTemplate
			if err := cc.cl.Do(cmd.Context(), http.MethodPatch, pushBase(id)+"/templates/"+api.PathID(cur.ID), in, &t); err != nil {
				return withCampaignHint(err, id)
			}
			return a.showPushTemplate(t)
		},
	}
	messageFlags(update, "rename the template")
	update.Flags().BoolVar(&clearData, "clear-data", false, "remove every data entry")
	c.AddCommand(create, update, &cobra.Command{
		Use:     "rm <channel> <template>",
		Aliases: []string{"remove", "delete"},
		Short:   "Delete a template; jobs already submitted are not affected",
		Args:    cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			cc, id, err := resolve(cmd, args[0], true)
			if err != nil {
				return err
			}
			cur, err := resolvePushTemplate(cmd.Context(), cc.cl, id, args[1])
			if err != nil {
				return err
			}
			if err := cc.cl.Do(cmd.Context(), http.MethodDelete, pushBase(id)+"/templates/"+api.PathID(cur.ID), nil, nil); err != nil {
				return withCampaignHint(err, id)
			}
			if a.jsonOut {
				return a.printer().JSONValue(map[string]any{"deleted": cur.ID})
			}
			fmt.Fprintf(a.Out, "deleted template %s (%s)\n", output.Clean(cur.Name), cur.ID)
			return nil
		},
	})
	return group(c)
}

func (a *App) pushJobCmd(resolve channelResolver) *cobra.Command {
	c := &cobra.Command{
		Use:     "job",
		Aliases: []string{"jobs"},
		Short:   "Campaign jobs: send a template to the users a CSV lists, follow it, fetch its report",
		Long: "Campaign jobs of a push channel (docs/push.md \"Campaigns\").\n\n" +
			"A job sends one template to the users a recipient CSV lists: a `userId`\n" +
			"column (a player id of the channel's auth channel) plus one column per\n" +
			"{{variable}} of the template. A column that reads like a device token is\n" +
			"refused. `submit --dry-run` counts what a real job would start from and\n" +
			"sends nothing. A job runs in the background, ends `done` or `failed`, and\n" +
			"its report names every row's result for 7 days.\n\n" +
			"Counts are per row (user), not per device. `skipped` is duplicates, missing\n" +
			"variables and invalid; `invalid` counts the report's skipped rows with\n" +
			"reason invalid-user, too-large or invalid-value (the row's value would put\n" +
			"a control character into the message). A cancel that arrives during the\n" +
			"last batch stops nothing: the job ends `done`, every row processed.\n\n" +
			"Limits (`yyt limit list --channel <channel>`): push.recipientsPerJob rows a\n" +
			"file and push.jobsPerDay jobs a UTC day, a broadcast counting as one and a\n" +
			"dry run as none.\n\n" +
			"A game server runs the same job routes with the channel apiKey as Bearer\n" +
			"under /push-api/{channelId}/… on the console API host (an unknown channel\n" +
			"id answers 401 there, like a wrong key); this CLI holds a console token\n" +
			"and calls /channels/{id}/push/….",
	}

	var template, csvPath, key string
	var dryRun, wait bool
	var timeout time.Duration
	var opts pushJobOptions
	submit := &cobra.Command{
		Use:   "submit <channel> --template <id|name> --csv <file>",
		Short: "Upload a recipient CSV and submit a job (or a --dry-run) for a template",
		Long: "Upload a recipient CSV and submit a job for a template.\n\n" +
			"Before any request the CSV header is checked here: a userId column, a\n" +
			"column for each variable of the template, valid and distinct names, no\n" +
			"column that reads like a device token. Rows are checked by the job.\n\n" +
			"Idempotency. Without --idempotency-key the key is derived from the\n" +
			"template id, the SHA-256 of the file and --dry-run, and printed on stderr:\n" +
			"running the same command again answers the job it made the first time and\n" +
			"submits nothing twice — also for a dry run, whose numbers are then the\n" +
			"earlier ones. To run the same file again, pass a new --idempotency-key.\n" +
			"The options (--priority, --ttl, --collapse-key) are not part of the derived\n" +
			"key: the same file with other options is refused (idempotency_key_reused).\n" +
			"A dry run and the job that follows it share one upload of the same file;\n" +
			"an upload whose submit was refused is removed again.\n\n" +
			"--wait polls until the job is done or failed and exits non-zero when it\n" +
			"failed; the job keeps running when the wait is interrupted or times out.",
		Example: "  yyt push job submit alerts --template welcome --csv users.csv --dry-run --wait\n" +
			"  yyt push job submit alerts --template welcome --csv users.csv --wait",
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			if key != "" && !pushIdemKey.MatchString(key) {
				return errors.New("--idempotency-key is [A-Za-z0-9][A-Za-z0-9._:-]{0,63}")
			}
			body := map[string]any{}
			if err := opts.apply(cmd, body); err != nil {
				return err
			}
			// Before any request: a bad file costs nothing.
			file, err := inspectPushCSV(csvPath)
			if err != nil {
				return err
			}
			cc, id, err := resolve(cmd, args[0], true)
			if err != nil {
				return err
			}
			tpl, err := resolvePushTemplate(ctx, cc.cl, id, template)
			if err != nil {
				return err
			}
			var missing []string
			for _, v := range tpl.Variables {
				found := false
				for _, col := range file.columns {
					found = found || col == v
				}
				if !found {
					missing = append(missing, v)
				}
			}
			if len(missing) > 0 {
				return fmt.Errorf("%s: the CSV needs a column for each variable of template %s; missing: %s", csvPath, output.Clean(tpl.Name), strings.Join(missing, ", "))
			}

			// The key, and for a derived one the key of the same file's other
			// mode: a dry run and its job share one upload.
			sibling := ""
			if key == "" {
				mode, other := "-send", "-dry"
				if dryRun {
					mode, other = other, mode
				}
				key = derivedPushKey(mode, "campaign", tpl.ID, file.sha256)
				sibling = derivedPushKey(other, "campaign", tpl.ID, file.sha256)
				fmt.Fprintf(a.Err, "idempotency key: %s (derived from the template, the file and --dry-run)\n", key)
			}
			body["templateId"] = tpl.ID
			body["idempotencyKey"] = key
			if dryRun {
				body["dryRun"] = true
			}
			post := func(uploadID string) (pushJobAnswer, error) {
				body["uploadId"] = uploadID
				return postPushJob(ctx, cc.cl, pushBase(id)+"/jobs", body)
			}

			// A job the key already names is answered with its own upload, so
			// the server replays it (or refuses other parameters) and no file
			// is uploaded.
			lookup := []string{key}
			if sibling != "" {
				lookup = append(lookup, sibling)
			}
			held, err := heldPushJobs(ctx, cc.cl, id, lookup...)
			if err != nil {
				return err
			}
			var res pushJobAnswer
			submitted := false
			if j, ok := held[key]; ok {
				if j.UploadID == nil {
					return withCampaignHint(&api.Error{Status: http.StatusConflict, Code: "conflict",
						Message: fmt.Sprintf("the idempotencyKey names %s %s", j.Kind, j.ID),
						Details: json.RawMessage(`{"reason":"idempotency_key_reused"}`)}, id)
				}
				if sibling == "" {
					fmt.Fprintf(a.Err, "the key names job %s: asking for that job again; %s is not uploaded or compared\n", j.ID, csvPath)
				}
				if res, err = post(*j.UploadID); err != nil {
					return withCampaignHint(err, id)
				}
				submitted = true
			} else if j, ok := held[sibling]; ok && sibling != "" && j.UploadID != nil {
				res, err = post(*j.UploadID)
				switch {
				case err == nil:
					fmt.Fprintf(a.Err, "reused the upload of %s %s (the same file)\n", pushJobKind(j), j.ID)
					submitted = true
				case !pushUploadGone(err):
					return withCampaignHint(err, id)
				}
			}
			if !submitted {
				uploadID, err := uploadPushCSV(ctx, cc.cl, id, csvPath, file.size)
				if err != nil {
					return err
				}
				fmt.Fprintf(a.Err, "uploaded %s (%d bytes)\n", csvPath, file.size)
				if res, err = post(uploadID); err != nil {
					// Refused before a job exists: the upload is nobody's.
					if pushSubmitRefused(err) {
						dropPushUpload(ctx, cc.cl, id, uploadID)
					}
					return withCampaignHint(err, id)
				}
			}
			return a.finishPushSubmit(ctx, cc.cl, res, wait, timeout)
		},
	}
	fl := submit.Flags()
	fl.StringVar(&template, "template", "", "the template to send (id or name)")
	fl.StringVar(&csvPath, "csv", "", "the recipient CSV: a userId column plus one per template variable")
	fl.BoolVar(&dryRun, "dry-run", false, "count what the job would start from and send nothing (needs no sender; not counted in push.jobsPerDay)")
	fl.StringVar(&key, "idempotency-key", "", "the job's key, [A-Za-z0-9][A-Za-z0-9._:-]{0,63} (default: derived, see above)")
	fl.BoolVar(&wait, "wait", false, "poll until the job is done or failed; exit non-zero when it failed")
	fl.DurationVar(&timeout, "timeout", 30*time.Minute, "with --wait: stop waiting after this long (the job keeps running)")
	opts.flags(submit)
	_ = submit.MarkFlagRequired("template")
	_ = submit.MarkFlagRequired("csv")
	c.AddCommand(submit)

	var limit int
	var cursor string
	ls := &cobra.Command{
		Use:     "ls <channel>",
		Aliases: []string{"list"},
		Short:   "List the channel's jobs and broadcasts, newest first",
		Args:    cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if cmd.Flags().Changed("limit") && (limit < 1 || limit > 100) {
				return fmt.Errorf("--limit is 1 to 100 (got %d)", limit)
			}
			cc, id, err := resolve(cmd, args[0], false)
			if err != nil {
				return err
			}
			q := url.Values{}
			if limit > 0 {
				q.Set("limit", strconv.Itoa(limit))
			}
			if cursor != "" {
				q.Set("cursor", cursor)
			}
			path := pushBase(id) + "/jobs"
			if len(q) > 0 {
				path += "?" + q.Encode()
			}
			var res struct {
				Jobs []pushJob `json:"jobs"`
				Next *string   `json:"next"`
			}
			if err := cc.cl.Do(cmd.Context(), http.MethodGet, path, nil, &res); err != nil {
				return withCampaignHint(err, id)
			}
			if a.jsonOut {
				return a.printer().JSONValue(res)
			}
			rows := make([][]string, 0, len(res.Jobs))
			for _, j := range res.Jobs {
				status := j.Status
				if j.Error != nil {
					status += ":" + *j.Error
				}
				total := "-"
				if j.Total != nil {
					total = strconv.FormatInt(*j.Total, 10)
				}
				done := j.Counts.Sent
				if j.DryRun {
					done = j.Counts.Resolved
				}
				rows = append(rows, []string{
					j.ID, pushJobKind(j), status, total, strconv.FormatInt(done, 10), strconv.FormatInt(j.Counts.Failed, 10),
					output.Time(j.CreatedAt), j.IdempotencyKey,
				})
			}
			if err := a.printer().Table([]string{"ID", "KIND", "STATUS", "ROWS", "SENT", "FAILED", "CREATED", "KEY"}, rows); err != nil {
				return err
			}
			if res.Next != nil && *res.Next != "" {
				fmt.Fprintf(a.Err, "more: --cursor %s\n", output.Clean(*res.Next))
			}
			return nil
		},
	}
	ls.Flags().IntVar(&limit, "limit", 0, "page size, 1 to 100 (default 20)")
	ls.Flags().StringVar(&cursor, "cursor", "", "the `more: --cursor …` value of the previous page")
	c.AddCommand(ls)

	// one runs a route addressed by job id and prints the job it answers.
	one := func(use, short, method, suffix string, write bool, note string) *cobra.Command {
		return &cobra.Command{
			Use:   use + " <channel> <job>",
			Short: short,
			Args:  cobra.ExactArgs(2),
			RunE: func(cmd *cobra.Command, args []string) error {
				if !pushJobID.MatchString(args[1]) {
					return fmt.Errorf("%q is not a job id (pj_…; yyt push job ls %s)", args[1], args[0])
				}
				cc, id, err := resolve(cmd, args[0], write)
				if err != nil {
					return err
				}
				var res pushJobAnswer
				if err := cc.cl.Do(cmd.Context(), method, pushBase(id)+"/jobs/"+api.PathID(args[1])+suffix, nil, &res); err != nil {
					return withCampaignHint(err, id)
				}
				if note != "" && !res.Job.finished() {
					fmt.Fprintln(a.Err, note)
				}
				return a.showPushJob(res.Job)
			},
		}
	}
	c.AddCommand(
		one("get", "Show a job: status, progress, per-row counts and why it failed", http.MethodGet, "", false, ""),
		one("cancel", "Ask a job to stop; rows already sent stay sent (a finished job is answered unchanged)", http.MethodPost, "/cancel", true,
			"cancel requested: the job ends between two batches, as failed with error canceled (as done when its last batch was already running)"),
	)

	var out string
	var force, printURL bool
	report := &cobra.Command{
		Use:   "report <channel> <job>",
		Short: "Download a finished job's report CSV (userId,status,reason; kept 7 days)",
		Long: "Download a finished job's report: one line per CSV row, in file order,\n" +
			"`userId,status,reason`. It lists the channel's players, so it is a team\n" +
			"member's read. Default output: ./push-report-<job>.csv, kept unless --force.\n\n" +
			"status: sent, no-token, unregistered, failed (reason unavailable or\n" +
			"rejected), skipped, and resolved in a dry run. A skipped row's reason is\n" +
			"duplicate, missing-variable, invalid-user, too-large or invalid-value (the\n" +
			"row's value would put a control character into the message); the last\n" +
			"three are the job's `invalid` count.\n\n" +
			"The download URL is a five-minute credential and is not printed; --url\n" +
			"prints it instead of downloading (treat it as a secret until it expires).",
		Args: cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			if !pushJobID.MatchString(args[1]) {
				return fmt.Errorf("%q is not a job id (pj_…; yyt push job ls %s)", args[1], args[0])
			}
			if printURL && (out != "" || force) {
				return errors.New("--url prints the link instead of downloading: drop -o/--force")
			}
			dst := out
			if dst == "" {
				dst = "push-report-" + args[1] + ".csv"
			}
			// Before any request, as `push channel config` does.
			if !printURL && dst != "-" && !force {
				if _, err := os.Lstat(dst); err == nil {
					return fmt.Errorf("%s exists: pass --force to replace it, or -o <file>", dst)
				}
			}
			// The server asks for a member's seat although nothing is written.
			cc, id, err := resolve(cmd, args[0], true)
			if err != nil {
				return err
			}
			var res struct {
				URL             string `json:"url"`
				ExpiresAt       int64  `json:"expiresAt"`
				ReportExpiresAt int64  `json:"reportExpiresAt"`
			}
			if err := cc.cl.Do(cmd.Context(), http.MethodGet, pushBase(id)+"/jobs/"+api.PathID(args[1])+"/report", nil, &res); err != nil {
				return withCampaignHint(err, id)
			}
			if res.URL == "" {
				return errors.New("the console answered a report without a URL")
			}
			if printURL {
				if a.jsonOut {
					return a.printer().JSONValue(res)
				}
				fmt.Fprintln(a.Out, res.URL)
				fmt.Fprintf(a.Err, "the link works until %s; the report is kept until %s\n", output.Time(res.ExpiresAt), output.Time(res.ReportExpiresAt))
				return nil
			}
			if err := defaultRetry.do(cmd.Context(), func() error {
				return redactURL(fetchTo(cmd.Context(), cc.cl.HTTP, res.URL, "", dst, a))
			}); err != nil {
				return err
			}
			fmt.Fprintln(a.Err, pushReportLegend)
			return nil
		},
	}
	report.Flags().StringVarP(&out, "output", "o", "", "where to write (default: ./push-report-<job>.csv; - is stdout)")
	report.Flags().BoolVar(&force, "force", false, "replace an existing file")
	report.Flags().BoolVar(&printURL, "url", false, "print the presigned download URL instead of downloading")
	c.AddCommand(report)
	return group(c)
}

func (a *App) pushBroadcastCmd(resolve channelResolver) *cobra.Command {
	var template, title, body, key string
	var data []string
	var wait bool
	var timeout time.Duration
	var opts pushJobOptions
	c := &cobra.Command{
		Use:   "broadcast <channel> (--template <id|name> | --title … [--body …] [--data k=v …])",
		Short: "Send one public message to every app install subscribed to the channel's topic",
		Long: "Send one message to the channel's FCM topic (`topic` in `yyt push channel get`).\n\n" +
			"Every app install that subscribed to the topic receives it; the platform\n" +
			"keeps no subscriber list, and FCM does not say how many devices it reached.\n" +
			"The message is a template without {{variables}} or literal text. A\n" +
			"broadcast is a job: `yyt push job get|ls` show it, it counts as one against\n" +
			"push.jobsPerDay, and it has no dry run and no report.\n\n" +
			"A broadcast is not confidential. Anyone who holds the app can subscribe to\n" +
			"the topic, so put no secret, no personal data and nothing that grants\n" +
			"something (a code, a reward) in it; send private content with a campaign\n" +
			"(`yyt push job submit`), which addresses the users a CSV lists.\n\n" +
			"There is no confirmation prompt: no yyt command prompts, and the command\n" +
			"sends when it is run. What guards a repeat is the idempotency key. Without\n" +
			"--idempotency-key it is derived from the message, the options and the UTC\n" +
			"day and printed on stderr, so the same broadcast run twice on one day is\n" +
			"sent once (the second run answers the first job). To send the same message\n" +
			"again that day, pass a new --idempotency-key.",
		Example: "  yyt push broadcast alerts --title \"Maintenance at 03:00 UTC\" --body \"About 20 minutes\" --wait\n" +
			"  yyt push broadcast alerts --template maintenance",
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			fl := cmd.Flags()
			inline := fl.Changed("title") || fl.Changed("body") || fl.Changed("data")
			if (template != "") == inline {
				return errors.New("give either --template or a literal message (--title, --body, --data)")
			}
			if key != "" && !pushIdemKey.MatchString(key) {
				return errors.New("--idempotency-key is [A-Za-z0-9][A-Za-z0-9._:-]{0,63}")
			}
			req := map[string]any{}
			if err := opts.apply(cmd, req); err != nil {
				return err
			}
			var m map[string]string
			if fl.Changed("data") {
				var err error
				if m, err = parsePushData(data); err != nil {
					return err
				}
			}
			cc, id, err := resolve(cmd, args[0], true)
			if err != nil {
				return err
			}
			var what string
			if template != "" {
				tpl, err := resolvePushTemplate(ctx, cc.cl, id, template)
				if err != nil {
					return err
				}
				if len(tpl.Variables) > 0 {
					return fmt.Errorf("template %s names variables (%s): %s", output.Clean(tpl.Name), strings.Join(tpl.Variables, ", "), pushCampaignHints["template_has_variables"])
				}
				req["templateId"] = tpl.ID
				what = "template\x00" + tpl.ID
			} else {
				if fl.Changed("title") {
					req["title"] = title
				}
				if fl.Changed("body") {
					req["body"] = body
				}
				if m != nil {
					req["data"] = m
				}
				what = "inline\x00" + title + "\x00" + body + "\x00" + pushDataText(m)
			}
			if key == "" {
				// The options are part of the key: the server refuses a key
				// whose options differ, and another option is another send.
				optKeys := make([]string, 0, 3)
				for _, k := range []string{"priority", "ttlSec", "collapseKey"} {
					if v, ok := req[k]; ok {
						optKeys = append(optKeys, fmt.Sprintf("%s=%v", k, v))
					}
				}
				sort.Strings(optKeys)
				day := pushNow().UTC().Format("20060102")
				key = derivedPushKey("-"+day, "broadcast", id, what, strings.Join(optKeys, "\x00"), day)
				fmt.Fprintf(a.Err, "idempotency key: %s (derived from the message, the options and the UTC day)\n", key)
			}
			req["idempotencyKey"] = key
			res, err := postPushJob(ctx, cc.cl, pushBase(id)+"/broadcast", req)
			if err != nil {
				return withCampaignHint(err, id)
			}
			return a.finishPushSubmit(ctx, cc.cl, res, wait, timeout)
		},
	}
	fl := c.Flags()
	fl.StringVar(&template, "template", "", "a template without variables (id or name)")
	fl.StringVar(&title, "title", "", "literal notification title")
	fl.StringVar(&body, "body", "", "literal notification body; needs a title")
	fl.StringArrayVar(&data, "data", nil, "literal data entry key=value (repeatable)")
	fl.StringVar(&key, "idempotency-key", "", "the broadcast's key, [A-Za-z0-9][A-Za-z0-9._:-]{0,63} (default: derived, see above)")
	fl.BoolVar(&wait, "wait", false, "poll until the broadcast is done or failed; exit non-zero when it failed")
	fl.DurationVar(&timeout, "timeout", 30*time.Minute, "with --wait: stop waiting after this long")
	opts.flags(c)
	return c
}
