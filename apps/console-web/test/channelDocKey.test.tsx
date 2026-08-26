import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../src/api";
import type { Channel, ChannelDocKey } from "../src/types";

const mockApi = {
  me: vi.fn(),
  logout: vi.fn(),
  loginUrl: vi.fn(() => "/auth/github/start"),
  setUnauthorizedHandler: vi.fn(),
  channel: vi.fn(),
  channels: vi.fn(),
  channelDocKey: vi.fn(),
  issueChannelDocKey: vi.fn(),
  revokeChannelDocKey: vi.fn(),
} as unknown as ApiClient;

vi.mock("../src/api", () => ({
  api: mockApi,
  ApiError: class extends Error {},
}));

const { ChannelDetailPage } = await import("../src/pages/ChannelDetail");
const { theme } = await import("../src/theme");
const { AuthProvider } = await import("../src/auth");

const CHANNEL: Channel = {
  id: "auth_9",
  kind: "auth",
  name: "login",
  ownerId: "m_1",
  config: {
    audience: "game-a",
    tokenTtlSec: 3600,
    redirectAllowlist: [],
    providers: {},
  },
  createdAt: 0,
  expiresAt: 0,
  disabledAt: null,
  status: "active",
  issuer: "yyt-auth/auth_9",
  startUrl: "https://auth-dev.yyt.life/c/auth_9/start",
  docUrl: "https://doc-dev.yyt.life",
};

const BLOCK: ChannelDocKey = {
  channelId: "auth_9",
  docUrl: "https://doc-dev.yyt.life",
  writePath: "/s/{ownerId}",
  issued: false,
  documents: 0,
};

function mount() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <MantineProvider theme={theme} forceColorScheme="light">
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/channels/auth_9"]}>
          <AuthProvider client={mockApi}>
            <Routes>
              <Route path="/channels/:id" element={<ChannelDetailPage />} />
            </Routes>
          </AuthProvider>
        </MemoryRouter>
      </QueryClientProvider>
    </MantineProvider>,
  );
}

describe("auth channel document key", () => {
  beforeEach(() => {
    // Call counts must not carry over: one test asserts the card's query is
    // never made at all.
    vi.clearAllMocks();
    vi.mocked(mockApi.me).mockResolvedValue({
      id: "m_1",
      login: "alice",
      role: "member",
      via: "session",
    });
    vi.mocked(mockApi.channel).mockResolvedValue(CHANNEL);
    vi.mocked(mockApi.channels).mockResolvedValue([]);
  });

  it("offers Issue while none exists and shows the key exactly once", async () => {
    vi.mocked(mockApi.channelDocKey).mockResolvedValue(BLOCK);
    const apiKey = `yds.auth_9.${"a".repeat(64)}`;
    vi.mocked(mockApi.issueChannelDocKey).mockResolvedValue({
      ...BLOCK,
      issued: true,
      apiKey,
    });
    mount();

    const issue = await screen.findByRole("button", { name: "Issue" });
    expect(screen.getByText(/Not issued yet/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Revoke" })).toBeNull();

    await userEvent.click(issue);
    expect(await screen.findByText(apiKey)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Re-issue" }),
    ).toBeInTheDocument();

    await userEvent.click(
      screen.getByRole("button", { name: "I have copied it" }),
    );
    expect(screen.queryByText(apiKey)).toBeNull();
  });

  it("clears the key on screen when it is revoked", async () => {
    vi.mocked(mockApi.channelDocKey).mockResolvedValue({
      ...BLOCK,
      issued: true,
      documents: 3,
    });
    const apiKey = `yds.auth_9.${"b".repeat(64)}`;
    vi.mocked(mockApi.issueChannelDocKey).mockResolvedValue({
      ...BLOCK,
      issued: true,
      apiKey,
    });
    vi.mocked(mockApi.revokeChannelDocKey).mockResolvedValue({ revoked: true });
    mount();

    expect(await screen.findByText(/3 documents stored/)).toBeInTheDocument();
    await userEvent.click(
      await screen.findByRole("button", { name: "Re-issue" }),
    );
    expect(await screen.findByText(apiKey)).toBeInTheDocument();

    // Confirm is two clicks: the trigger, then the confirmation.
    await userEvent.click(screen.getByRole("button", { name: "Revoke" }));
    const confirm = screen
      .getAllByRole("button")
      .find((b) => /confirm|revoke/i.test(b.textContent ?? ""));
    await userEvent.click(confirm!);

    // Leaving it up would show a key that no longer authenticates anything.
    await screen.findByText(/Not issued yet/);
    expect(screen.queryByText(apiKey)).toBeNull();
  });

  it("hides the buttons from a non-owner but still shows the block", async () => {
    vi.mocked(mockApi.me).mockResolvedValue({
      id: "m_admin",
      login: "root",
      role: "admin",
      via: "session",
    });
    vi.mocked(mockApi.channelDocKey).mockResolvedValue({
      ...BLOCK,
      issued: true,
    });
    mount();

    expect(
      (await screen.findAllByText("https://doc-dev.yyt.life")).length,
    ).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "Re-issue" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Revoke" })).toBeNull();
  });

  it("shows no card at all when the state stack is not deployed", async () => {
    vi.mocked(mockApi.channel).mockResolvedValue({
      ...CHANNEL,
      docUrl: undefined,
    });
    vi.mocked(mockApi.channelDocKey).mockResolvedValue(BLOCK);
    mount();

    await screen.findByText("login");
    expect(screen.queryByText("Document storage")).toBeNull();
    // And the card's own query is never made: there is nothing to configure.
    expect(mockApi.channelDocKey).not.toHaveBeenCalled();
  });
});
