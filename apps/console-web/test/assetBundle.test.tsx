import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../src/api";
import type { AssetBundleDetail, TeamDetail } from "../src/types";

const mockApi = {
  me: vi.fn(),
  logout: vi.fn(),
  loginUrl: vi.fn(() => "/auth/github/start"),
  setUnauthorizedHandler: vi.fn(),
  team: vi.fn(),
  assetBundle: vi.fn(),
  assetVersion: vi.fn(),
  updateAssetBundle: vi.fn(),
  deleteAssetBundle: vi.fn(),
  deleteAssetVersion: vi.fn(),
  uploadAssetFile: vi.fn(),
} as unknown as ApiClient;

vi.mock("../src/api", () => ({
  api: mockApi,
  ApiError: class extends Error {},
}));

const { AssetBundlePage } = await import("../src/pages/AssetBundle");
const { mount } = await import("./wrap");

const TEAM: TeamDetail = { id: "team_1", name: "studio", role: "member" };
const BUNDLE: AssetBundleDetail = {
  id: "ab_1",
  name: "dungeon-maps",
  description: "maps",
  createdAt: 0,
  updatedAt: 0,
  teamId: "team_1",
  teamName: "studio",
  projectId: "prj_1",
  projectName: "dungeon",
  createdBy: "alice",
  bytes: 4096,
  versions: [{ version: "v1", files: 2, bytes: 4096, createdAt: 0 }],
};

function open(bundle = BUNDLE) {
  vi.mocked(mockApi.assetBundle).mockResolvedValue(bundle);
  return mount(
    <Routes>
      <Route path="/assets/:id" element={<AssetBundlePage />} />
      <Route
        path="/teams/:team/projects/:prj/:tab"
        element={<p>project tab</p>}
      />
    </Routes>,
    { client: mockApi, path: "/assets/ab_1" },
  );
}

describe("AssetBundlePage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(mockApi.me).mockResolvedValue({
      id: "u1",
      login: "alice",
      role: "member",
      via: "session",
    });
    vi.mocked(mockApi.team).mockResolvedValue(TEAM);
    vi.mocked(mockApi.assetVersion).mockResolvedValue({
      files: [
        {
          id: "f1",
          bundleId: "ab_1",
          version: "v1",
          path: "maps/a.json",
          url: "https://cdn.example/assets/ab_1/v1/maps/a.json",
          objectKey: "k",
          contentType: "application/json",
          size: 10,
          hash: null,
          createdAt: 0,
        },
      ],
    } as never);
  });

  it("lists versions, opens a version's files and shows the CDN prefix", async () => {
    open();
    expect(
      await screen.findByRole("heading", { name: "dungeon-maps" }),
    ).toBeInTheDocument();
    expect(screen.getByText("v1")).toBeInTheDocument();
    expect(screen.getByText("assets/ab_1/")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Show files" }));
    await waitFor(() =>
      expect(mockApi.assetVersion).toHaveBeenCalledWith("ab_1", "v1"),
    );
    expect(await screen.findByText("maps/a.json")).toBeInTheDocument();
    for (const col of ["Path", "Type", "Size", "URL"])
      expect(
        screen.getByRole("columnheader", { name: col }),
      ).toBeInTheDocument();
  });

  it("shows the empty state", async () => {
    open({ ...BUNDLE, versions: [] });
    expect(
      await screen.findByText("No versions published yet."),
    ).toBeInTheDocument();
  });

  it("saves the description and deletes a version after confirmation", async () => {
    vi.mocked(mockApi.updateAssetBundle).mockResolvedValue({
      ...BUNDLE,
      description: "all maps",
    });
    vi.mocked(mockApi.deleteAssetVersion).mockResolvedValue(undefined);
    open();
    const desc = await screen.findByLabelText("Description");
    await userEvent.clear(desc);
    await userEvent.type(desc, "all maps");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(mockApi.updateAssetBundle).toHaveBeenCalledWith("ab_1", {
        description: "all maps",
      }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Delete version" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(mockApi.deleteAssetVersion).toHaveBeenCalledWith("ab_1", "v1"),
    );
  });

  it("deletes the bundle and returns to the project's assets", async () => {
    vi.mocked(mockApi.deleteAssetBundle).mockResolvedValue(undefined);
    open();
    await screen.findByRole("heading", { name: "dungeon-maps" });
    await userEvent.click(
      await screen.findByRole("button", { name: "Delete bundle" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Delete everything" }),
    );
    await waitFor(() =>
      expect(mockApi.deleteAssetBundle).toHaveBeenCalledWith("ab_1"),
    );
    expect(await screen.findByText("project tab")).toBeInTheDocument();
  });

  it("hides publishing from a seatless admin", async () => {
    vi.mocked(mockApi.team).mockResolvedValue({ ...TEAM, role: "admin" });
    open();
    await screen.findByRole("heading", { name: "dungeon-maps" });
    expect(await screen.findByText(/Read-only/)).toBeInTheDocument();
    expect(screen.queryByText("Publish a version")).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete bundle" })).toBeNull();
  });
});
