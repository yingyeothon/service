-- Pre-design skeleton schema; rewritten to docs/tracer.md "Storage" before the first deploy.
-- Projects live in the config file; project_id columns reference config ids.

CREATE TABLE envelopes (
  id          INTEGER PRIMARY KEY,
  project_id  INTEGER NOT NULL,
  received_at INTEGER NOT NULL,          -- unix millis
  event_id    TEXT,
  sdk         TEXT,
  bytes       INTEGER NOT NULL,
  remote_ip   TEXT
);
CREATE INDEX envelopes_project_received ON envelopes(project_id, received_at);

CREATE TABLE events (
  id              INTEGER PRIMARY KEY,
  envelope_id     INTEGER REFERENCES envelopes(id) ON DELETE CASCADE,
  project_id      INTEGER NOT NULL,
  event_id        TEXT NOT NULL,
  ts              INTEGER NOT NULL,      -- unix millis
  level           TEXT,
  platform        TEXT,
  release         TEXT,
  environment     TEXT,
  message         TEXT,
  exception_type  TEXT,
  exception_value TEXT,
  device          TEXT,
  os              TEXT,
  json            TEXT NOT NULL          -- full event JSON, breadcrumbs included
);
CREATE INDEX events_project_ts ON events(project_id, ts);
CREATE UNIQUE INDEX events_project_event_id ON events(project_id, event_id);

CREATE TABLE breadcrumbs (
  id        INTEGER PRIMARY KEY,
  event_row INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  ts        INTEGER,                     -- unix millis
  category  TEXT,
  level     TEXT,
  message   TEXT,
  data_json TEXT
);
CREATE INDEX breadcrumbs_event ON breadcrumbs(event_row);
CREATE INDEX breadcrumbs_category_ts ON breadcrumbs(category, ts);

CREATE TABLE logs (
  id              INTEGER PRIMARY KEY,
  project_id      INTEGER NOT NULL,
  ts              INTEGER NOT NULL,      -- unix millis
  level           TEXT,
  body            TEXT,
  trace_id        TEXT,
  attributes_json TEXT
);
CREATE INDEX logs_project_ts ON logs(project_id, ts);

CREATE TABLE attachments (
  id           INTEGER PRIMARY KEY,
  envelope_id  INTEGER REFERENCES envelopes(id) ON DELETE CASCADE,
  project_id   INTEGER NOT NULL,
  event_id     TEXT,
  filename     TEXT,
  content_type TEXT,
  attachment_type TEXT,
  bytes        INTEGER NOT NULL,
  blob         BLOB
);
CREATE INDEX attachments_event ON attachments(project_id, event_id);

-- Accepted-and-dropped items, so discarded volume stays visible.
CREATE TABLE drops (
  day        TEXT NOT NULL,              -- YYYY-MM-DD (UTC)
  project_id INTEGER NOT NULL,
  item_type  TEXT NOT NULL,
  count      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, project_id, item_type)
);
