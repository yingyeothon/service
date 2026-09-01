import { describe, expect, it } from "vitest";
import { NAV_ITEMS, navMinRole } from "../src/navigation";
import { ROUTES } from "../src/routes";

describe("routes", () => {
  it("guards every non-public route with an existing navigation item", () => {
    for (const r of ROUTES) {
      if (r.guard === null) continue;
      expect(() => navMinRole(r.guard!), r.path).not.toThrow();
    }
  });

  it("keeps the hidden items as guards without listing them", () => {
    const hidden = NAV_ITEMS.filter((i) => i.hidden).map((i) => i.path);
    expect(hidden).toEqual(["/channels", "/catalog", "/assets", "/sites"]);
    for (const h of hidden) expect(navMinRole(h)).toBe("member");
    expect(navMinRole("/teams")).toBe("member");
  });

  it("routes teams, projects, issues and discussions", () => {
    const paths = ROUTES.map((r) => r.path);
    for (const p of [
      "/teams",
      "/teams/:team",
      "/teams/:team/:tab",
      "/teams/:team/discussions/:id",
      "/teams/:team/projects/:prj",
      "/teams/:team/projects/:prj/:tab",
      "/teams/:team/projects/:prj/channels/new",
      "/teams/:team/projects/:prj/issues/:n",
      "/channels/:id",
      "/catalog/apps/:id",
      "/assets/:id",
      "/sites/:id",
    ])
      expect(paths).toContain(p);
    // Creation lives under a project now; the old top-level path is gone.
    expect(paths).not.toContain("/channels/new");
    expect(paths).not.toContain("/catalog/groups/:id");
  });

  it("keeps the show routes public and the audit log admin-only", () => {
    const byPath = new Map(ROUTES.map((r) => [r.path, r.guard]));
    // A `public` show is readable by anonymous visitors, so the route cannot
    // be guarded; the show's own ACL decides, per request.
    for (const p of ["/shows", "/shows/:id", "/shows/:id/entries/:eid"]) {
      expect(byPath.has(p), p).toBe(true);
      expect(byPath.get(p), p).toBeNull();
    }
    expect(byPath.get("/audit")).toBe("/audit");
    expect(navMinRole("/audit")).toBe("admin");
    // Visible, not hidden: the hidden list is pinned above and must stay four.
    expect(NAV_ITEMS.find((i) => i.path === "/audit")?.hidden).toBeUndefined();
    expect(NAV_ITEMS.find((i) => i.path === "/shows")?.minRole).toBeNull();
  });
});
