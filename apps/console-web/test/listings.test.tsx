import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../src/api";
import type { AdminCatalogListing, PublicListing } from "../src/types";

const mockApi = {
  me: vi.fn(),
  logout: vi.fn(),
  loginUrl: vi.fn((next: string) => `/auth/github/start?next=${next}`),
  setUnauthorizedHandler: vi.fn(),
  catalogListings: vi.fn(),
  adminCatalogListings: vi.fn(),
  takedownCatalogListing: vi.fn(),
  restoreCatalogListing: vi.fn(),
} as unknown as ApiClient;

vi.mock("../src/api", () => ({
  api: mockApi,
  ApiError: class extends Error {},
}));

const { ListingsPage } = await import("../src/pages/Listings");
const { AdminListingsPage } = await import("../src/pages/AdminListings");
const { mount } = await import("./wrap");

const ROW: PublicListing = {
  appId: "ca_1",
  appName: "my-game",
  teamName: "studio",
  title: "My Game",
  summary: "A short one.",
  tags: ["rpg", "co-op"],
  audience: "public",
  publishedAt: 0,
  updatedAt: 0,
  artifacts: [
    {
      id: "art_a",
      appId: "ca_1",
      platform: "android",
      url: "https://cdn.example/a.apk",
      size: 10,
      hash: null,
      tags: { version: "1.4.2" },
      createdAt: 0,
    },
    {
      id: "art_i",
      appId: "ca_1",
      platform: "ios",
      url: "https://cdn.example/a.ipa",
      size: 10,
      hash: null,
      tags: { version: "1.4.1", distribution_method: "ad-hoc" },
      createdAt: 0,
      ios: {
        manifestUrl: "https://cdn.example/m.plist",
        installUrl:
          "itms-services://?action=download-manifest&url=https%3A%2F%2Fcdn.example%2Fm.plist",
      },
    },
  ],
  latestArtifact: null,
  applicationIds: [],
};

describe("ListingsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(mockApi.catalogListings).mockResolvedValue([ROW]);
  });

  it("lists what an anonymous visitor may read, with one download per platform", async () => {
    vi.mocked(mockApi.me).mockRejectedValue(new Error("401"));
    mount(<ListingsPage />, { client: mockApi, path: "/listings" });
    expect(
      await screen.findByRole("heading", { name: "Apps" }),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole("link", { name: "Sign in" }),
    ).toHaveAttribute("href", "/auth/github/start?next=/listings");
    for (const c of [
      "Title",
      "Team",
      "Who may install",
      "Tags",
      "Downloads",
      "Published",
    ])
      expect(
        await screen.findByRole("columnheader", { name: c }),
      ).toBeInTheDocument();
    // The title is a disclosure: the summary and tags fold out under it.
    const title = await screen.findByRole("button", { name: "My Game" });
    expect(title).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("A short one.")).not.toBeVisible();
    await userEvent.click(title);
    expect(
      within(
        await screen.findByRole("group", { name: "About My Game" }),
      ).getByText("A short one."),
    ).toBeVisible();
    expect(screen.getByText("studio")).toBeInTheDocument();
    expect(screen.getByText("everyone")).toBeInTheDocument();
    expect(screen.getAllByText("rpg, co-op").length).toBeGreaterThan(0);
    // The first download is inline (the CDN file); the rest fold out, and an
    // iOS ad-hoc build links to its OTA install URL.
    expect(
      screen.getByRole("link", { name: "android 1.4.2 of My Game" }),
    ).toHaveAttribute("href", "https://cdn.example/a.apk");
    await userEvent.click(
      screen.getByRole("button", { name: "+1 more downloads of My Game" }),
    );
    expect(
      within(
        await screen.findByRole("group", {
          name: "Every download of My Game",
        }),
      ).getByRole("link", { name: "ios 1.4.1 of My Game" }),
    ).toHaveAttribute("href", expect.stringMatching(/^itms-services:/));
    expect(vi.mocked(mockApi.catalogListings)).toHaveBeenLastCalledWith({});
  });

  it("hands search, platform and sort to the server", async () => {
    vi.mocked(mockApi.me).mockResolvedValue({
      id: "u1",
      login: "alice",
      role: "member",
      via: "session",
    });
    mount(<ListingsPage />, { client: mockApi, path: "/listings" });
    expect(
      await screen.findByRole("button", { name: "My Game" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Sign in" })).toBeNull();
    await userEvent.type(screen.getByRole("searchbox"), "game");
    await waitFor(() =>
      expect(vi.mocked(mockApi.catalogListings)).toHaveBeenLastCalledWith({
        q: "game",
      }),
    );
    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: "Platform" }),
      "ios",
    );
    await waitFor(() =>
      expect(vi.mocked(mockApi.catalogListings)).toHaveBeenLastCalledWith({
        q: "game",
        platform: "ios",
      }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Published" }));
    await waitFor(() =>
      expect(vi.mocked(mockApi.catalogListings)).toHaveBeenLastCalledWith({
        q: "game",
        platform: "ios",
        sort: "publishedAt",
        order: "desc",
      }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Title" }));
    await waitFor(() =>
      expect(vi.mocked(mockApi.catalogListings)).toHaveBeenLastCalledWith({
        q: "game",
        platform: "ios",
        sort: "title",
        order: "asc",
      }),
    );
  });
});

const ADMIN_ROW: AdminCatalogListing = {
  appId: "ca_1",
  appName: "my-game",
  teamId: "team_1",
  teamName: "studio",
  title: "My Game",
  summary: null,
  tags: [],
  audience: "members",
  publishedBy: "alice",
  publishedAt: 0,
  updatedAt: 0,
  takenDown: false,
  takedown: null,
};

async function rowAction(name: string, verb: string) {
  await userEvent.click(
    await screen.findByRole("button", { name: `Actions for ${name}` }),
  );
  await userEvent.click(await screen.findByRole("menuitem", { name: verb }));
}

describe("AdminListingsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(mockApi.me).mockResolvedValue({
      id: "u9",
      login: "root",
      role: "admin",
      via: "session",
    });
  });

  it("takes a listing down with a reason and clears it again", async () => {
    vi.mocked(mockApi.adminCatalogListings).mockResolvedValue([ADMIN_ROW]);
    vi.mocked(mockApi.takedownCatalogListing).mockImplementation(
      async (appId, reason) => {
        const row = {
          ...ADMIN_ROW,
          takenDown: true,
          takedown: { by: "root", at: 5, reason: reason ?? null },
        };
        vi.mocked(mockApi.adminCatalogListings).mockResolvedValue([row]);
        return { appId, takedown: row.takedown, listing: row };
      },
    );
    vi.mocked(mockApi.restoreCatalogListing).mockImplementation(async () => {
      vi.mocked(mockApi.adminCatalogListings).mockResolvedValue([ADMIN_ROW]);
    });
    mount(
      <Routes>
        <Route path="/admin/listings" element={<AdminListingsPage />} />
      </Routes>,
      { client: mockApi, path: "/admin/listings" },
    );
    expect(await screen.findByText("My Game")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "my-game" })).toHaveAttribute(
      "href",
      "/catalog/apps/ca_1",
    );
    expect(screen.getByText("live")).toBeInTheDocument();
    expect(screen.getByText("members")).toBeInTheDocument();

    await rowAction("My Game", "Take down");
    const dialog = await screen.findByRole("dialog");
    await userEvent.type(
      within(dialog).getByRole("textbox", { name: "Reason" }),
      "not ok",
    );
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Take down" }),
    );
    await waitFor(() =>
      expect(mockApi.takedownCatalogListing).toHaveBeenCalledWith(
        "ca_1",
        "not ok",
      ),
    );
    expect(await screen.findByText("taken down")).toBeInTheDocument();
    // The reason folds out under the status; it is not hover-only.
    await userEvent.click(
      screen.getByRole("button", { name: "by root, takedown of My Game" }),
    );
    expect(
      within(
        await screen.findByRole("group", { name: "Takedown of My Game" }),
      ).getByText("not ok"),
    ).toBeVisible();

    await rowAction("My Game", "Clear takedown");
    await userEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "Clear takedown",
      }),
    );
    await waitFor(() =>
      expect(mockApi.restoreCatalogListing).toHaveBeenCalledWith("ca_1"),
    );
    expect(await screen.findByText("live")).toBeInTheDocument();
  });

  it("searches on the server", async () => {
    vi.mocked(mockApi.adminCatalogListings).mockResolvedValue([]);
    mount(<AdminListingsPage />, { client: mockApi, path: "/admin/listings" });
    expect(
      await screen.findByText("Nothing is published."),
    ).toBeInTheDocument();
    await userEvent.type(screen.getByRole("searchbox"), "bad");
    await waitFor(() =>
      expect(vi.mocked(mockApi.adminCatalogListings)).toHaveBeenLastCalledWith({
        q: "bad",
      }),
    );
    expect(await screen.findByText("No rows match “bad”.")).toBeInTheDocument();
  });
});
