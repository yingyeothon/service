ALTER TABLE sites ADD COLUMN access_json TEXT NULL;
CREATE TABLE site_edge_policies (
 prefix VARCHAR(32) COLLATE utf8mb4_bin NOT NULL PRIMARY KEY,
 payload TEXT NOT NULL, pending BOOLEAN NOT NULL DEFAULT TRUE
) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;
CREATE TABLE site_edge_control (
 id INT NOT NULL PRIMARY KEY, month VARCHAR(7) NOT NULL, used INT NOT NULL DEFAULT 0
);
INSERT INTO site_edge_control (id, month, used) VALUES (1, '', 0);
