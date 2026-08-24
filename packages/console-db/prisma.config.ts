import { defineConfig } from "prisma/config";

// Builds the datasource URL from the same MYSQL_* variables used by the
// runtime (local/env/console.<stage>.env). Never print this URL: it embeds
// the password.
const url = () => {
  const host = process.env["MYSQL_HOST"] ?? "localhost";
  const port = process.env["MYSQL_PORT"] ?? "3306";
  const enc = (k: string, fallback: string) =>
    encodeURIComponent(process.env[k] ?? fallback);
  // prettier-ignore
  return `mysql://${enc("MYSQL_USER", "root")}:${enc("MYSQL_PASSWORD", "")}@${host}:${port}/${enc("MYSQL_DATABASE", "yyt")}`;
};

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: { url: url() },
});
