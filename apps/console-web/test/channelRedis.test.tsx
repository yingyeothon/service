import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../src/api";
import type { Channel, ChannelRedisUser } from "../src/types";

const mockApi = {
  me: vi.fn(),
  logout: vi.fn(),
  loginUrl: vi.fn(() => "/auth/github/start"),
  setUnauthorizedHandler: vi.fn(),
  channel: vi.fn(),
  channels: vi.fn(),
  team: vi.fn(),
  projectChannels: vi.fn(),
  channelRedisUser: vi.fn(),
  issueChannelRedisUser: vi.fn(),
  revokeChannelRedisUser: vi.fn(),
} as unknown as ApiClient;

vi.mock("../src/api", () => ({
  api: mockApi,
  ApiError: class extends Error {},
}));

const { ChannelDetailPage } = await import("../src/pages/ChannelDetail");
const { theme } = await import("../src/theme");
const { AuthProvider } = await import("../src/auth");

const CHANNEL: Channel = {
  id: "q_0123",
  kind: "q",
  name: "dungeon",
  teamId: "team_1",
  teamName: "studio",
  projectId: "prj_1",
  projectName: "game",
  createdBy: "alice",
  config: { authChannelId: "auth_9" },
  createdAt: 0,
  expiresAt: 0,
  disabledAt: null,
  status: "active",
  wsUrl: "wss://gw-dev.yyt.life/?channel=q_0123",
  redis: {
    eventKeyPrefix: "game:dev:q_0123:event:",
    queueKeyPrefix: "game:dev:q_0123:queue:",
    lockKeyPrefix: "game:dev:q_0123:lock:",
    awaiterKeyPrefix: "game:dev:q_0123:awaiter:",
    channelPrefix: "game:out:dev:q_0123:",
    aclKeyPattern: "~game:dev:q_0123:*",
    aclChannelPattern: "&game:out:dev:q_0123:*",
    aclUsername: "game_dev_q_0123",
  },
};

const BLOCK: ChannelRedisUser = {
  channelId: "q_0123",
  host: "redis.example",
  port: 6379,
  username: "game_dev_q_0123",
  eventKeyPrefix: "game:dev:q_0123:event:",
  queueKeyPrefix: "game:dev:q_0123:queue:",
  lockKeyPrefix: "game:dev:q_0123:lock:",
  awaiterKeyPrefix: "game:dev:q_0123:awaiter:",
  channelPrefix: "game:out:dev:q_0123:",
};

function mount() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <MantineProvider theme={theme} forceColorScheme="light">
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/channels/q_0123"]}>
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

describe("q channel redis account", () => {
  beforeEach(() => {
    vi.mocked(mockApi.me).mockResolvedValue({
      id: "m_1",
      login: "alice",
      role: "member",
      via: "session",
    });
    vi.mocked(mockApi.channel).mockResolvedValue(CHANNEL);
    vi.mocked(mockApi.channels).mockResolvedValue([]);
    vi.mocked(mockApi.projectChannels).mockResolvedValue([]);
    // Seated member of the channel's team: may issue and revoke.
    vi.mocked(mockApi.team).mockResolvedValue({
      id: "team_1",
      name: "studio",
      role: "member",
    });
  });

  it("offers Issue while none exists and shows the password exactly once", async () => {
    vi.mocked(mockApi.channelRedisUser).mockResolvedValue({
      ...BLOCK,
      issued: false,
    });
    const password = "a".repeat(64);
    vi.mocked(mockApi.issueChannelRedisUser).mockResolvedValue({
      ...BLOCK,
      password,
    });
    mount();

    const issue = await screen.findByRole("button", { name: "Issue" });
    expect(screen.getByText(/Not issued yet/)).toBeInTheDocument();
    // The five tslib prefixes are one copyable block (docs/decisions.md,
    // participant credentials): a prefix typed by hand is a silent no-op.
    expect(
      screen.getByText(
        /eventKeyPrefix=game:dev:q_0123:event:.*queueKeyPrefix=.*lockKeyPrefix=.*awaiterKeyPrefix=.*channelPrefix=game:out:dev:q_0123:/s,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getAllByRole("button", { name: /Copy tslib prefixes/ }),
    ).toHaveLength(1);
    // Nothing to revoke before anything was issued.
    expect(screen.queryByRole("button", { name: "Revoke" })).toBeNull();

    await userEvent.click(issue);
    // Shown once, and the button now offers a rotation rather than a first issue.
    expect(await screen.findByText(password)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Re-issue" }),
    ).toBeInTheDocument();

    await userEvent.click(
      screen.getByRole("button", { name: "I have copied it" }),
    );
    expect(screen.queryByText(password)).toBeNull();
  });

  it("clears the password when the account is revoked", async () => {
    vi.mocked(mockApi.channelRedisUser).mockResolvedValue({
      ...BLOCK,
      issued: true,
    });
    const password = "b".repeat(64);
    vi.mocked(mockApi.issueChannelRedisUser).mockResolvedValue({
      ...BLOCK,
      password,
    });
    vi.mocked(mockApi.revokeChannelRedisUser).mockResolvedValue({
      revoked: true,
    });
    mount();

    await userEvent.click(
      await screen.findByRole("button", { name: "Re-issue" }),
    );
    expect(await screen.findByText(password)).toBeInTheDocument();

    // Confirm is two clicks: the trigger, then the confirmation.
    await userEvent.click(screen.getByRole("button", { name: "Revoke" }));
    const confirm = screen
      .getAllByRole("button")
      .find((b) => /confirm|revoke/i.test(b.textContent ?? ""));
    await userEvent.click(confirm!);

    // Leaving it on screen would show a password for an account that is gone.
    await screen.findByText(/Not issued yet/);
    expect(screen.queryByText(password)).toBeNull();
  });

  it("says so, and hides the buttons, when the stage has no issuer", async () => {
    vi.mocked(mockApi.channelRedisUser).mockResolvedValue({
      ...BLOCK,
      configured: false,
    });
    mount();

    expect(
      await screen.findByText(/no credential issuer configured/),
    ).toBeInTheDocument();
    // The prefixes are still the ones the Lambda must use, so the block stays.
    expect(
      screen.getByText(/queueKeyPrefix=game:dev:q_0123:queue:/),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Issue" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Re-issue" })).toBeNull();
  });

  it("warns when the credential could not be persisted", async () => {
    vi.mocked(mockApi.channelRedisUser).mockResolvedValue({
      ...BLOCK,
      issued: false,
    });
    vi.mocked(mockApi.issueChannelRedisUser).mockResolvedValue({
      ...BLOCK,
      password: "c".repeat(64),
      persisted: false,
    });
    mount();

    await userEvent.click(await screen.findByRole("button", { name: "Issue" }));
    expect(
      await screen.findByText(/disappear the next time Redis restarts/),
    ).toBeInTheDocument();
  });

  it("hides the buttons from a seatless admin but still shows the block", async () => {
    vi.mocked(mockApi.me).mockResolvedValue({
      id: "m_admin",
      login: "root",
      role: "admin",
      via: "session",
    });
    vi.mocked(mockApi.team).mockResolvedValue({
      id: "team_1",
      name: "studio",
      role: "admin",
    });
    vi.mocked(mockApi.channelRedisUser).mockResolvedValue({
      ...BLOCK,
      issued: true,
    });
    mount();

    expect(await screen.findByText(/^Issued\./)).toBeInTheDocument();
    // Once in the derived-names block, once in the account card: the two must
    // agree, which is the whole point of deriving the username.
    expect(screen.getAllByText("game_dev_q_0123")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "Re-issue" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Revoke" })).toBeNull();
  });
});
