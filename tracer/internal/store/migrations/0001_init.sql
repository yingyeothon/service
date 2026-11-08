-- tracer schema (docs/tracer.md _Storage_). Append-only once deployed.
-- Times are unix milliseconds UTC. resource_id is the console's `trc_…` id;
-- tracer holds no resource table of its own (decisions _Debug collector_ #9).
-- Retention walks received_ms; read API lists select by received_ms (server
-- clock) and order/window by ts_ms (device clock).

-- One row per process-wide fact (livez write probe, retention bookkeeping).
CREATE TABLE meta (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);

-- `event` and `feedback` items. Breadcrumbs and tags are split into rows; json
-- holds the rest of the payload, bounded by ingest.
CREATE TABLE events (
  id                  INTEGER PRIMARY KEY,
  resource_id         TEXT NOT NULL,
  event_id            TEXT NOT NULL,      -- 32 lowercase hex
  type                TEXT NOT NULL,      -- event | feedback
  ts_ms               INTEGER NOT NULL,   -- client timestamp
  received_ms         INTEGER NOT NULL,
  level               TEXT,
  platform            TEXT,
  release             TEXT,
  dist                TEXT,
  environment         TEXT,
  trace_id            TEXT,
  user_id             TEXT,
  device              TEXT,               -- model
  os                  TEXT,               -- name + version
  group_key           TEXT,               -- issues.group_key; NULL for feedback
  title               TEXT,
  message             TEXT,
  exception_type      TEXT,
  exception_value     TEXT,
  associated_event_id TEXT,               -- feedback → the event it reports
  json                TEXT NOT NULL,
  UNIQUE (resource_id, event_id)
);
CREATE INDEX events_res_ts ON events(resource_id, ts_ms);
CREATE INDEX events_res_group ON events(resource_id, group_key, ts_ms);
CREATE INDEX events_res_trace ON events(resource_id, trace_id) WHERE trace_id IS NOT NULL;
CREATE INDEX events_res_assoc ON events(resource_id, associated_event_id) WHERE associated_event_id IS NOT NULL;
CREATE INDEX events_received ON events(received_ms);
CREATE INDEX events_res_received ON events(resource_id, received_ms); -- read API since/until

CREATE TABLE event_tags (
  event_row   INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  resource_id TEXT NOT NULL,
  key         TEXT NOT NULL,
  value       TEXT NOT NULL,
  PRIMARY KEY (event_row, key)
) WITHOUT ROWID;
CREATE INDEX event_tags_res_kv ON event_tags(resource_id, key, value);

CREATE TABLE breadcrumbs (
  id          INTEGER PRIMARY KEY,
  event_row   INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  resource_id TEXT NOT NULL,
  ts_ms       INTEGER,
  type        TEXT,
  category    TEXT,
  level       TEXT,
  message     TEXT,
  data_json   TEXT
);
CREATE INDEX breadcrumbs_event ON breadcrumbs(event_row);
CREATE INDEX breadcrumbs_res_ts ON breadcrumbs(resource_id, ts_ms);

-- One row per group (fingerprint, else exception type + top in-app frame, else message).
CREATE TABLE issues (
  resource_id     TEXT NOT NULL,
  group_key       TEXT NOT NULL,
  title           TEXT,
  level           TEXT,
  count           INTEGER NOT NULL DEFAULT 0,
  first_seen_ms   INTEGER NOT NULL,
  last_seen_ms    INTEGER NOT NULL,
  latest_event_id TEXT,
  status          TEXT NOT NULL DEFAULT 'unresolved',
  PRIMARY KEY (resource_id, group_key)
) WITHOUT ROWID;
CREATE INDEX issues_res_last ON issues(resource_id, last_seen_ms);
-- Retention deletes a group once its last event has aged out.
CREATE INDEX issues_last ON issues(last_seen_ms);

-- `log` container items, one row per log entry. Log entries carry no id;
-- dedupe_key = first 16 bytes of sha256 over the entry's JSON bytes as
-- received (sentry-android resends an item's stored bytes; docs/tracer.md).
CREATE TABLE logs (
  id              INTEGER PRIMARY KEY,
  resource_id     TEXT NOT NULL,
  ts_ms           INTEGER NOT NULL,
  received_ms     INTEGER NOT NULL,
  level           TEXT,
  body            TEXT,
  trace_id        TEXT,
  span_id         TEXT,
  release         TEXT,
  environment     TEXT,
  user_id         TEXT,
  device          TEXT,
  attributes_json TEXT,
  dedupe_key      BLOB NOT NULL,          -- sha256(entry bytes)[:16]
  UNIQUE (resource_id, dedupe_key)
);
CREATE INDEX logs_res_ts ON logs(resource_id, ts_ms);
CREATE INDEX logs_res_trace ON logs(resource_id, trace_id, ts_ms) WHERE trace_id IS NOT NULL;
CREATE INDEX logs_received ON logs(received_ms);
CREATE INDEX logs_res_received ON logs(resource_id, received_ms); -- read API since/until

CREATE TABLE transactions (
  id          INTEGER PRIMARY KEY,
  resource_id TEXT NOT NULL,
  event_id    TEXT NOT NULL,
  trace_id    TEXT,
  name        TEXT,
  op          TEXT,
  status      TEXT,
  start_ms    INTEGER NOT NULL,
  end_ms      INTEGER,
  received_ms INTEGER NOT NULL,
  release     TEXT,
  environment TEXT,
  device      TEXT,
  json        TEXT NOT NULL,
  UNIQUE (resource_id, event_id)
);
CREATE INDEX transactions_res_start ON transactions(resource_id, start_ms);
CREATE INDEX transactions_res_trace ON transactions(resource_id, trace_id) WHERE trace_id IS NOT NULL;
CREATE INDEX transactions_received ON transactions(received_ms);

-- Attachment bytes live in files: blobs/{resource}/{yyyy-mm-dd}/{blob_id}.
-- blob_id is server-minted; filename is the client's, display only.
CREATE TABLE attachments (
  id              INTEGER PRIMARY KEY,
  resource_id     TEXT NOT NULL,
  event_id        TEXT,
  blob_id         TEXT NOT NULL UNIQUE,
  path            TEXT NOT NULL,          -- relative to the blob root
  filename        TEXT,
  content_type    TEXT,
  attachment_type TEXT,
  size            INTEGER NOT NULL,
  sha256          TEXT NOT NULL,
  received_ms     INTEGER NOT NULL
);
CREATE INDEX attachments_res_event ON attachments(resource_id, event_id);
-- A retried envelope must not store its screenshot twice.
CREATE UNIQUE INDEX attachments_dedupe ON attachments(resource_id, event_id, sha256) WHERE event_id IS NOT NULL;
CREATE INDEX attachments_received ON attachments(received_ms);

-- One row per `session` (sid), merged on each update (docs/tracer.md
-- _Ingest_: terminal status beats ok, then highest (seq, updated_ms); errors
-- max; started_ms/did first), so a retried envelope changes nothing.
-- Aggregated `sessions` items are counted in drops (not_stored).
CREATE TABLE sessions (
  resource_id TEXT NOT NULL,
  sid         TEXT NOT NULL,
  did         TEXT,                       -- installation id
  status      TEXT NOT NULL,              -- ok | exited | crashed | abnormal
  errors      INTEGER NOT NULL DEFAULT 0,
  seq         INTEGER NOT NULL DEFAULT 0,
  started_ms  INTEGER,
  updated_ms  INTEGER NOT NULL,
  release     TEXT,
  environment TEXT,
  received_ms INTEGER NOT NULL,
  PRIMARY KEY (resource_id, sid)
) WITHOUT ROWID;
CREATE INDEX sessions_res_started ON sessions(resource_id, started_ms);
CREATE INDEX sessions_received ON sessions(received_ms);

-- Items accepted and discarded, or refused, so lost volume stays visible.
-- reason per item: not_stored (accepted-and-counted types), unknown,
-- quota_attachment, too_large, invalid; per refused envelope (item_type
-- 'envelope'): busy, quota_refused, disk, too_large, invalid, console, store_error.
CREATE TABLE drops (
  day         TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  item_type   TEXT NOT NULL,
  reason      TEXT NOT NULL,
  count       INTEGER NOT NULL DEFAULT 0,
  bytes       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (resource_id, day, item_type, reason)
) WITHOUT ROWID;

-- Per-resource UTC daily byte counters for `tracer.dailyBytes`
-- (decompressed bytes accepted); quota_hit_ms is the first crossing that day.
CREATE TABLE daily_bytes (
  resource_id  TEXT NOT NULL,
  day          TEXT NOT NULL,
  bytes        INTEGER NOT NULL DEFAULT 0,
  quota_hit_ms INTEGER,
  PRIMARY KEY (resource_id, day)
) WITHOUT ROWID;
