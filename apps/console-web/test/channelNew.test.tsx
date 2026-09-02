import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../src/api";
import type { ProjectDetail, TeamDetail } from "../src/types";

const mockApi = {
  me: vi.fn(),
  logout: vi.fn(),
  loginUrl: vi.fn(() => "/auth/github/start"),
  setUnauthorizedHandler: vi.fn(),
  team: vi.fn(),
  project: vi.fn(),
  projectChannels: vi.fn(),
  createChannel: vi.fn(),
} as unknown as ApiClient;

vi.mock("../src/api", () => ({
  api: mockApi,
  ApiError: class extends Error {},
}));

const { ChannelNewPage } = await import("../src/pages/ChannelNew");
const { mount } = await import("./wrap");

const TEAM: TeamDetail = { id: "team_1", name: "studio", role: "member" };
const PROJECT: ProjectDetail = {
  id: "prj_1",
  teamId: "team_1",
  teamName: "studio",
  name: "dungeon",
  description: null,
  createdBy: "alice",
  createdAt: 0,
  updatedAt: 0,
  counts: {
    channels: 0,
    apps: 0,
    bundles: 0,
    sites: 0,
    versions: 0,
    issues: 0,
  },
};

function open() {
  return mount(
    <Routes>
      <Route
        path="/teams/:team/projects/:prj/channels/new"
        element={<ChannelNewPage />}
      />
    </Routes>,
    { client: mockApi, path: "/teams/team_1/projects/prj_1/channels/new" },
  );
}

describe("ChannelNewPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(mockApi.me).mockResolvedValue({
      id: "u1",
      login: "alice",
      role: "member",
      via: "session",
    });
    vi.mocked(mockApi.team).mockResolvedValue(TEAM);
    vi.mocked(mockApi.project).mockResolvedValue(PROJECT);
    vi.mocked(mockApi.projectChannels).mockResolvedValue([]);
  });

  it("offers the five kinds and cancels back to the project's channels", async () => {
    open();
    expect(
      await screen.findByRole("heading", { name: "New channel" }),
    ).toBeInTheDocument();
    const kind = await screen.findByLabelText("Kind");
    expect(kind).toBeInTheDocument();
    expect(
      screen.getAllByRole<HTMLOptionElement>("option").map((o) => o.value),
    ).toEqual(["auth", "topic", "match", "lobby", "q"]);
    expect(screen.getByRole("link", { name: "Cancel" })).toHaveAttribute(
      "href",
      "/teams/team_1/projects/prj_1/channels",
    );
    expect(screen.getByRole("link", { name: "dungeon" })).toHaveAttribute(
      "href",
      "/teams/team_1/projects/prj_1",
    );
  });

  it("refuses a topic channel while the project has no auth channel", async () => {
    open();
    await screen.findByRole("heading", { name: "New channel" });
    await userEvent.selectOptions(
      await screen.findByLabelText("Kind"),
      "topic",
    );
    await waitFor(() =>
      expect(mockApi.projectChannels).toHaveBeenCalledWith("prj_1", "auth"),
    );
    expect(
      await screen.findByText(/need an auth channel in this project/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Create channel" }),
    ).toBeDisabled();
    await userEvent.click(
      screen.getByRole("button", { name: "Create an auth channel" }),
    );
    expect(screen.getByLabelText("Kind")).toHaveValue("auth");
  });

  it("is read-only for a seatless admin", async () => {
    vi.mocked(mockApi.team).mockResolvedValue({ ...TEAM, role: "admin" });
    open();
    await screen.findByRole("heading", { name: "New channel" });
    expect(await screen.findByText(/Read-only/)).toBeInTheDocument();
    expect(
      await screen.findByRole("button", { name: "Create channel" }),
    ).toBeDisabled();
  });
});
