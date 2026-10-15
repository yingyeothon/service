-- Preserve registered legacy path-host prefixes; managed site slugs stay unchanged.
ALTER TABLE site_edge_policies MODIFY prefix VARCHAR(64) COLLATE utf8mb4_bin NOT NULL;
