import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../src/api";
import type { SiteDetail, TeamDetail } from "../src/types";

const mockApi = {
  me: vi.fn(),
  logout: vi.fn(),
  loginUrl: vi.fn(() => "/auth/github/start"),
  setUnauthorizedHandler: vi.fn(),
  team: vi.fn(),
  site: vi.fn(),
  updateSite: vi.fn(),
  deleteSite: vi.fn(),
  deploySite: vi.fn(),
} as unknown as ApiClient;

vi.mock("../src/api", () => ({
  api: mockApi,
  ApiError: class extends Error {},
}));

const { SitePage, SITE_SHARED_ORIGIN_WARNING } =
  await import("../src/pages/Site");
const { mount } = await import("./wrap");

const TEAM: TeamDetail = { id: "team_1", name: "studio", role: "member" };
const SITE: SiteDetail = {
  id: "site_1",
  name: "game-web",
  slug: "abc123",
  description: "the client",
  publicUrl: "https://g.yyt.life/abc123/",
  basePath: "/abc123/",
  currentDeployId: "dep_1",
  busy: false,
  createdAt: 0,
  updatedAt: 0,
  teamId: "team_1",
  teamName: "studio",
  projectId: "prj_1",
  projectName: "dungeon",
  createdBy: "alice",
  currentDeploy: null,
  warning: "",
  deploys: [
    {
      id: "dep_1",
      siteId: "site_1",
      status: "live",
      zipBytes: 10,
      bytes: 2048,
      files: 3,
      error: null,
      createdBy: "alice",
      createdAt: 0,
      updatedAt: 0,
      expiresAt: 0,
    },
  ],
};

function open(site = SITE) {
  vi.mocked(mockApi.site).mockResolvedValue(site);
  return mount(
    <Routes>
      <Route path="/sites/:id" element={<SitePage />} />
      <Route
        path="/teams/:team/projects/:prj/:tab"
        element={<p>project tab</p>}
      />
    </Routes>,
    { client: mockApi, path: "/sites/site_1" },
  );
}

describe("SitePage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(mockApi.me).mockResolvedValue({
      id: "u1",
      login: "alice",
      role: "member",
      via: "session",
    });
    vi.mocked(mockApi.team).mockResolvedValue(TEAM);
  });

  it("shows the crumbs, the public URL, the warning and the deploys", async () => {
    open();
    expect(
      await screen.findByRole("heading", { name: "game-web" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "dungeon" })).toHaveAttribute(
      "href",
      "/teams/team_1/projects/prj_1",
    );
    expect(
      screen.getByRole("link", { name: "https://g.yyt.life/abc123/" }),
    ).toHaveAttribute("target", "_blank");
    expect(screen.getByText(SITE_SHARED_ORIGIN_WARNING)).toBeInTheDocument();
    for (const col of [
      "Deploy id",
      "Status",
      "Files",
      "Size",
      "Error",
      "Created",
    ])
      expect(
        screen.getByRole("columnheader", { name: col }),
      ).toBeInTheDocument();
    expect(screen.getByText("live")).toBeInTheDocument();
    expect(screen.getAllByText("/abc123/").length).toBeGreaterThan(0);
  });

  it("saves only the changed fields from the edit drawer", async () => {
    vi.mocked(mockApi.updateSite).mockResolvedValue({ ...SITE, name: "web" });
    open();
    await userEvent.click(await screen.findByRole("button", { name: "Edit" }));
    const drawer = await screen.findByRole("dialog");
    const name = within(drawer).getByLabelText(/^Name/);
    await userEvent.clear(name);
    await userEvent.type(name, "web");
    await userEvent.click(within(drawer).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(mockApi.updateSite).toHaveBeenCalledWith("site_1", {
        name: "web",
      }),
    );
    expect(
      await screen.findByRole("heading", { name: "web" }),
    ).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("deletes from the drawer danger zone after a confirmation and returns to the project's sites", async () => {
    vi.mocked(mockApi.deleteSite).mockResolvedValue(undefined);
    open();
    await userEvent.click(await screen.findByRole("button", { name: "Edit" }));
    const drawer = await screen.findByRole("dialog");
    await userEvent.click(
      within(drawer).getByRole("button", { name: "Delete site" }),
    );
    const modal = (await screen.findByText("Delete site?")).closest(
      '[role="dialog"]',
    ) as HTMLElement;
    await userEvent.click(
      within(modal).getByRole("button", { name: "Delete site" }),
    );
    await waitFor(() =>
      expect(mockApi.deleteSite).toHaveBeenCalledWith("site_1"),
    );
    expect(await screen.findByText("project tab")).toBeInTheDocument();
  });

  it("is read-only for a seatless admin", async () => {
    vi.mocked(mockApi.team).mockResolvedValue({ ...TEAM, role: "admin" });
    open();
    await screen.findByRole("heading", { name: "game-web" });
    expect(await screen.findByText(/Read-only/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Deploy" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.queryByRole("button", { name: "More actions" })).toBeNull();
  });
});
