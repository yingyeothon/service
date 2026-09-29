import { describe, expect, it, vi } from "vitest";
import { NAV_ITEMS, navMinRole } from "../src/navigation";

// Pins the chunk split: the route table must not pull `qrcode` in statically
// (the `/app-login` page is the only user and is loaded lazily). It guards
// `routes.tsx` only — a static import of the page from elsewhere would
// re-bundle `qrcode` without failing here; the `$$typeof` check still holds.
const { qrLoaded } = vi.hoisted(() => ({ qrLoaded: vi.fn() }));
vi.mock("qrcode", () => {
  qrLoaded();
  return { default: {} };
});
const { ROUTES } = await import("../src/routes");

describe("routes", () => {
  it("loads the QR page lazily", () => {
    expect(qrLoaded).not.toHaveBeenCalled();
    const el = ROUTES.find((r) => r.path === "/app-login")?.element;
    expect((el?.type as { $$typeof?: symbol } | undefined)?.$$typeof).toBe(
      Symbol.for("react.lazy"),
    );
  });

  it("guards every non-public route with an existing navigation item", () => {
    for (const r of ROUTES) {
      if (r.guard === null) continue;
      expect(() => navMinRole(r.guard!), r.path).not.toThrow();
    }
  });

  it("keeps the hidden items as guards without listing them", () => {
    const hidden = NAV_ITEMS.filter((i) => i.hidden).map((i) => i.path);
    expect(hidden).toEqual([
      "/channels",
      "/catalog",
      "/assets",
      "/sites",
      "/kv",
      "/leaderboards",
    ]);
    for (const h of hidden) expect(navMinRole(h)).toBe("member");
    expect(navMinRole("/teams")).toBe("member");
    // The project sub-tree is guarded as one: a channel is created inside a
    // project, so its route follows `/teams`, not the hidden `/channels`.
    expect(
      ROUTES.find((r) => r.path === "/teams/:team/projects/:prj/channels/new")
        ?.guard,
    ).toBe("/teams");
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
      "/teams/:team/projects/:prj/versions/:ver",
      "/channels/:id",
      "/catalog/apps/:id",
      "/assets/:id",
      "/sites/:id",
      "/kv/:id",
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
    // Visible, not hidden: the hidden list is pinned above and must stay five.
    expect(NAV_ITEMS.find((i) => i.path === "/audit")?.hidden).toBeUndefined();
    expect(NAV_ITEMS.find((i) => i.path === "/shows")?.minRole).toBeNull();
  });

  it("keeps the listing browse page public, and it is the only listing page", () => {
    const byPath = new Map(ROUTES.map((r) => [r.path, r.guard]));
    expect(byPath.has("/listings")).toBe(true);
    expect(byPath.get("/listings")).toBeNull();
    expect(NAV_ITEMS.find((i) => i.path === "/listings")?.minRole).toBeNull();
    // The admin's takedown lives in that page's row menu (decision #8).
    expect(byPath.has("/admin/listings")).toBe(false);
    expect(NAV_ITEMS.some((i) => i.path === "/admin/listings")).toBe(false);
  });

  it("keeps the limit request queue admin-only and in the menu", () => {
    const byPath = new Map(ROUTES.map((r) => [r.path, r.guard]));
    // The path the request e-mail links to (`/ui/admin/limit-requests`).
    expect(byPath.get("/admin/limit-requests")).toBe("/admin/limit-requests");
    expect(navMinRole("/admin/limit-requests")).toBe("admin");
    const item = NAV_ITEMS.find((i) => i.path === "/admin/limit-requests");
    expect(item?.hidden).toBeUndefined();
    expect(item?.label).toBe("Limit requests");
    expect(item?.badge).toBe("pendingLimitRequests");
  });
});
