import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../src/api";
import type { Channel, LimitsView } from "../src/types";

const mockApi = {
  me: vi.fn(),
  logout: vi.fn(),
  loginUrl: vi.fn(() => "/auth/github/start"),
  setUnauthorizedHandler: vi.fn(),
  channel: vi.fn(),
  channels: vi.fn(),
  team: vi.fn(),
  projectChannels: vi.fn(),
  extendChannel: vi.fn(),
  limits: vi.fn(),
  requestLimit: vi.fn(),
  cancelLimitRequest: vi.fn(),
} as unknown as ApiClient;

vi.mock("../src/api", () => ({
  api: mockApi,
  ApiError: class extends Error {},
}));

const { ChannelDetailPage } = await import("../src/pages/ChannelDetail");
const { ChannelsPage } = await import("../src/pages/Channels");
const { mount: mountWith } = await import("./wrap");

const NO_EXPIRY = 253402300799;
const SOON = Math.floor(Date.now() / 1000) + 3 * 86400;

const channel = (expiresAt: number): Channel => ({
  id: "topic_1",
  kind: "topic",
  name: "chat",
  teamId: "team_1",
  teamName: "studio",
  projectId: "prj_1",
  projectName: "game",
  createdBy: "alice",
  config: { authChannelId: "auth_9" },
  createdAt: 0,
  expiresAt,
  disabledAt: null,
  status: "active",
  apiBase: "https://topic.example",
  wsUrl: "wss://topic.example",
});

const limits = (expiresAt: number): LimitsView => {
  const none = expiresAt === NO_EXPIRY;
  return {
    scope: { kind: "channel", id: "topic_1" },
    teamId: "team_1",
    expiresAt,
    limits: [
      {
        key: "channel.lifetime",
        unit: "seconds",
        soft: 2419200,
        hard: "unlimited",
        effective: none ? "unlimited" : 2419200,
        usage: null,
        override: none
          ? {
              value: "unlimited",
              expiresAt: null,
              note: "event",
              requestId: null,
              grantedBy: "u9",
              grantedByLogin: "boss",
              grantedAt: 0,
            }
          : null,
      },
    ],
    pending: [],
  };
};

function openDetail(expiresAt: number) {
  vi.mocked(mockApi.channel).mockResolvedValue(channel(expiresAt));
  vi.mocked(mockApi.limits).mockResolvedValue(limits(expiresAt));
  return mountWith(
    <Routes>
      <Route path="/channels/:id" element={<ChannelDetailPage />} />
    </Routes>,
    { client: mockApi, path: "/channels/topic_1" },
  );
}

describe("a channel granted no expiry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(mockApi.me).mockResolvedValue({
      id: "m_1",
      login: "alice",
      role: "member",
      via: "session",
    });
    vi.mocked(mockApi.projectChannels).mockResolvedValue([]);
    vi.mocked(mockApi.team).mockResolvedValue({
      id: "team_1",
      name: "studio",
      role: "member",
    });
  });

  it("says No expiry on the detail page and offers no extend", async () => {
    openDetail(NO_EXPIRY);
    expect(
      await screen.findByRole("heading", { name: "chat" }),
    ).toBeInTheDocument();
    const header = screen.getByRole("banner");
    expect(within(header).getByText(/No expiry/)).toBeInTheDocument();
    expect(within(header).queryByText(/9999/)).toBeNull();
    expect(within(header).queryByText(/Expires/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Extend +7 days" })).toBeNull();
    // The limits section agrees, and there is nothing left to ask for.
    const section = (
      await screen.findByRole("heading", { name: "Limits" })
    ).closest("section")!;
    expect(
      await within(section).findByRole("button", {
        name: "raised Lifetime: details",
      }),
    ).toBeInTheDocument();
    expect(
      within(section).queryByRole("button", { name: "Request increase" }),
    ).toBeNull();
    expect(mockApi.limits).toHaveBeenCalledWith("channel:topic_1");
  });

  it("keeps extend and the date on a channel that still expires", async () => {
    openDetail(SOON);
    expect(
      await screen.findByRole("heading", { name: "chat" }),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole("banner")).getByText(/Expires .* \(in 3d\)/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Extend +7 days" }),
    ).toBeInTheDocument();
    const section = (
      await screen.findByRole("heading", { name: "Limits" })
    ).closest("section")!;
    expect(
      await within(section).findByRole("button", {
        name: "Request increase",
      }),
    ).toBeInTheDocument();
  });

  it("lists it as No expiry with no extend in its row menu", async () => {
    vi.mocked(mockApi.channels).mockResolvedValue([
      channel(NO_EXPIRY),
      { ...channel(SOON), id: "topic_2", name: "lobby-chat" },
    ]);
    mountWith(<ChannelsPage />, { client: mockApi });
    const row = (await screen.findByRole("link", { name: "chat" })).closest(
      "tr",
    )!;
    expect(within(row).getByText("No expiry")).toBeInTheDocument();
    await userEvent.click(
      within(row).getByRole("button", { name: "Actions for chat" }),
    );
    expect(
      await screen.findByRole("menuitem", { name: "Delete channel" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("menuitem", { name: "Extend +7 days" }),
    ).toBeNull();
    await userEvent.keyboard("{Escape}");
    const other = screen
      .getByRole("link", { name: "lobby-chat" })
      .closest("tr")!;
    expect(within(other).getByText("in 3d")).toBeInTheDocument();
    await userEvent.click(
      within(other).getByRole("button", { name: "Actions for lobby-chat" }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("menuitem", { name: "Extend +7 days" }),
      ).toBeInTheDocument(),
    );
  });
});
