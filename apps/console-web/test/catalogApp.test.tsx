import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../src/api";
import type { CatalogApp, CatalogArtifact, TeamDetail } from "../src/types";

const mockApi = {
  me: vi.fn(),
  logout: vi.fn(),
  loginUrl: vi.fn(() => "/auth/github/start"),
  setUnauthorizedHandler: vi.fn(),
  team: vi.fn(),
  catalogApp: vi.fn(),
  catalogArtifacts: vi.fn(),
  catalogSettings: vi.fn(),
  updateCatalogSettings: vi.fn(),
  updateCatalogApp: vi.fn(),
  deleteCatalogApp: vi.fn(),
  deleteCatalogArtifact: vi.fn(),
  cleanupCatalogArtifacts: vi.fn(),
  uploadCatalogArtifact: vi.fn(),
} as unknown as ApiClient;

vi.mock("../src/api", () => ({
  api: mockApi,
  ApiError: class extends Error {},
}));

const { CatalogAppPage } = await import("../src/pages/CatalogApp");
const { mount } = await import("./wrap");

const TEAM: TeamDetail = { id: "team_1", name: "studio", role: "member" };
const APP: CatalogApp = {
  id: "ca_1",
  name: "my-game",
  path: "life.yyt.my-game",
  description: null,
  createdAt: 0,
  updatedAt: 0,
  teamId: "team_1",
  teamName: "studio",
  projectId: "prj_1",
  projectName: "dungeon",
  createdBy: "alice",
};
const ARTIFACTS: CatalogArtifact[] = [
  {
    id: "art_1",
    appId: "ca_1",
    platform: "android",
    url: "https://cdn.example/a.apk",
    objectKey: "apps/ca_1/1.0.0/a.apk",
    size: 1024,
    hash: null,
    tags: { version: "1.0.0" },
    createdAt: 0,
  },
];

function open() {
  vi.mocked(mockApi.catalogApp).mockResolvedValue(APP);
  vi.mocked(mockApi.catalogArtifacts).mockResolvedValue(ARTIFACTS);
  return mount(
    <Routes>
      <Route path="/catalog/apps/:id" element={<CatalogAppPage />} />
      <Route
        path="/teams/:team/projects/:prj/:tab"
        element={<p>project tab</p>}
      />
    </Routes>,
    { client: mockApi, path: "/catalog/apps/ca_1" },
  );
}

describe("CatalogAppPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(mockApi.me).mockResolvedValue({
      id: "u1",
      login: "alice",
      role: "member",
      via: "session",
    });
    vi.mocked(mockApi.team).mockResolvedValue(TEAM);
    vi.mocked(mockApi.catalogSettings).mockResolvedValue({
      slackHookUrl: null,
      slackChannel: null,
      messageTemplate: null,
      keepRecentVersions: 5,
    });
  });

  it("shows the app, its artifacts grouped by version and the settings", async () => {
    open();
    expect(
      await screen.findByRole("heading", { name: "my-game" }),
    ).toBeInTheDocument();
    expect(screen.getByText("ca_1")).toBeInTheDocument();
    expect(await screen.findByText("1.0.0")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "a.apk" })).toHaveAttribute(
      "href",
      "https://cdn.example/a.apk",
    );
    expect(
      await screen.findByLabelText("Slack webhook URL"),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Keep recent versions")).toHaveValue("5");
  });

  it("saves the changed info fields and deletes an artifact after confirmation", async () => {
    vi.mocked(mockApi.updateCatalogApp).mockResolvedValue({
      ...APP,
      path: "life.yyt.game",
    });
    vi.mocked(mockApi.deleteCatalogArtifact).mockResolvedValue(undefined);
    open();
    const path = await screen.findByLabelText("Application id");
    await userEvent.clear(path);
    await userEvent.type(path, "life.yyt.game");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(mockApi.updateCatalogApp).toHaveBeenCalledWith("ca_1", {
        path: "life.yyt.game",
      }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    await userEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() =>
      expect(mockApi.deleteCatalogArtifact).toHaveBeenCalledWith(
        "ca_1",
        "art_1",
      ),
    );
  });

  it("saves settings", async () => {
    vi.mocked(mockApi.updateCatalogSettings).mockResolvedValue({
      slackHookUrl: null,
      slackChannel: "#releases",
      messageTemplate: null,
      keepRecentVersions: 5,
    });
    open();
    const ch = await screen.findByLabelText("Slack channel");
    await userEvent.type(ch, "#releases");
    await userEvent.click(
      screen.getByRole("button", { name: "Save settings" }),
    );
    await waitFor(() =>
      expect(mockApi.updateCatalogSettings).toHaveBeenCalledWith("ca_1", {
        slackChannel: "#releases",
      }),
    );
  });

  it("deletes the app and returns to the project's catalog", async () => {
    vi.mocked(mockApi.deleteCatalogApp).mockResolvedValue(undefined);
    open();
    await screen.findByRole("heading", { name: "my-game" });
    await userEvent.click(
      await screen.findByRole("button", { name: "Delete app" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() =>
      expect(mockApi.deleteCatalogApp).toHaveBeenCalledWith("ca_1"),
    );
    expect(await screen.findByText("project tab")).toBeInTheDocument();
  });

  it("hides upload, settings and cleanup from a seatless admin", async () => {
    vi.mocked(mockApi.team).mockResolvedValue({ ...TEAM, role: "admin" });
    open();
    await screen.findByRole("heading", { name: "my-game" });
    expect(await screen.findByText(/Read-only/)).toBeInTheDocument();
    expect(screen.queryByText("Upload artifact")).toBeNull();
    expect(screen.queryByLabelText("Slack webhook URL")).toBeNull();
    expect(screen.queryByRole("button", { name: "Run cleanup" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete app" })).toBeNull();
  });
});
