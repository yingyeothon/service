-- Cross-owner prefix search (`GET /kv/{col}/entries?prefix=` on a
-- `readScope: project` + `writeScope: user` collection) walks every owner's
-- rows and the primary key `(collection_id, owner_id, k)` cannot serve it —
-- `owner_id` sits between the filter columns (S1 measured 45,100 rows read
-- for 51 hits). Owner decision 2026-09-06: index it rather than restrict it.
-- Pure expand: an index on existing columns, no data change.
CREATE INDEX `kv_entries_prefix` ON `kv_entries`(`collection_id`, `k`);
