import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../src/api";

const mockApi = {
  me: vi.fn(),
  logout: vi.fn(),
  loginUrl: vi.fn(
    (next: string) => `/auth/github/start?next=${encodeURIComponent(next)}`,
  ),
  events: vi.fn(),
  channels: vi.fn(),
  teams: vi.fn(),
  tokens: vi.fn(),
  members: vi.fn(),
  installerApp: vi.fn(),
  installerDownloads: vi.fn(),
  setUnauthorizedHandler: vi.fn(),
} as unknown as ApiClient;

vi.mock("../src/api", () => ({
  api: mockApi,
  ApiError: class extends Error {
    constructor(
      readonly status: number,
      readonly code: string,
      message: string,
      readonly details?: unknown,
    ) {
      super(message);
    }
  },
}));

const { App } = await import("../src/App");
const { theme } = await import("../src/theme");
const { AuthProvider } = await import("../src/auth");

function mount(path: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <MantineProvider theme={theme} forceColorScheme="light">
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[path]}>
          <AuthProvider client={mockApi}>
            <App />
          </AuthProvider>
        </MemoryRouter>
      </QueryClientProvider>
    </MantineProvider>,
  );
}

describe("App", () => {
  beforeEach(() => {
    vi.mocked(mockApi.events).mockResolvedValue([]);
    vi.mocked(mockApi.channels).mockResolvedValue([]);
    vi.mocked(mockApi.teams).mockResolvedValue([]);
    vi.mocked(mockApi.tokens).mockResolvedValue([]);
    vi.mocked(mockApi.members).mockResolvedValue([]);
    vi.mocked(mockApi.installerDownloads).mockResolvedValue([]);
    vi.mocked(mockApi.installerApp).mockResolvedValue({
      appId: null,
      appName: null,
      teamId: null,
      teamName: null,
      trusted: false,
      updatedAt: null,
    });
  });

  it("asks anonymous visitors to sign in on protected pages, with next= preserved", async () => {
    vi.mocked(mockApi.me).mockResolvedValue(null);
    mount("/channels?kind=auth");
    expect(await screen.findByText("Sign in to continue.")).toBeInTheDocument();
    const link = screen.getByRole("link", { name: "Sign in with GitHub" });
    expect(link.getAttribute("href")).toBe(
      "/auth/github/start?next=%2Fchannels%3Fkind%3Dauth",
    );
    expect(screen.queryByRole("link", { name: "Teams" })).toBeNull();
  });

  it("tells pending members to wait and hides admin navigation", async () => {
    vi.mocked(mockApi.me).mockResolvedValue({
      id: "m_1",
      login: "someone",
      role: "pending",
      via: "session",
    });
    mount("/channels");
    expect(await screen.findByText(/waiting for an admin/)).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "API tokens" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Members" })).toBeNull();
  });

  it("shows the public events list without a session", async () => {
    vi.mocked(mockApi.me).mockResolvedValue(null);
    vi.mocked(mockApi.events).mockResolvedValue([
      {
        id: "ev_1",
        title: "Summer jam",
        status: "waiting",
        place: "Seoul",
        durationHours: 8,
        voteUntil: 0,
        startsAt: 86400,
        owner: "octo",
        mine: false,
        createdAt: 0,
        updatedAt: 0,
        publishedAt: 0,
        hasPoster: true,
      },
    ]);
    mount("/events");
    expect(
      await screen.findByRole("link", { name: "Summer jam" }),
    ).toBeInTheDocument();
    expect(screen.getByText("waiting")).toBeInTheDocument();
    expect(screen.getByText("Seoul")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New event" })).toBeNull();
  });

  it("shows the Teams nav item to members and keeps Channels out of the menu", async () => {
    vi.mocked(mockApi.me).mockResolvedValue({
      id: "m_1",
      login: "someone",
      role: "member",
      via: "session",
    });
    mount("/teams");
    // Wait until the member session is reflected in the nav.
    const links = await screen.findAllByRole("link", { name: "Teams" });
    expect(links.length).toBeGreaterThan(0);
    expect(await screen.findByText(/not in any team yet/)).toBeInTheDocument();
    // Hidden items stay guards, not menu entries.
    const nav = screen.getByRole("navigation", { name: "Main" });
    expect(nav.textContent).not.toContain("Channels");
    expect(screen.queryByRole("link", { name: "Members" })).toBeNull();
  });

  it("lets admins see the members page", async () => {
    vi.mocked(mockApi.me).mockResolvedValue({
      id: "m_1",
      login: "root",
      role: "admin",
      via: "session",
    });
    vi.mocked(mockApi.members).mockResolvedValue([
      {
        id: "m_2",
        login: "newbie",
        role: "pending",
        createdAt: 0,
        approvedAt: null,
        approvedBy: null,
      },
    ]);
    mount("/members");
    expect(
      await screen.findByRole("button", { name: "Approve" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/1 sign-up waiting/)).toBeInTheDocument();
  });
});

describe("installer downloads", () => {
  const member = {
    login: "alice",
    role: "member" as const,
    memberId: "m_1",
    teams: [],
  };
  const builds = [
    {
      url: "https://d.example/installer-1.2.0.apk",
      filename: "installer-1.2.0.apk",
      platform: "android" as const,
      version: "1.2.0+14",
      createdAt: 1_787_757_641,
    },
    {
      url: "https://d.example/app-release.apk",
      filename: "app-release.apk",
      platform: "android" as const,
      version: "1.1.0+13",
      createdAt: 1_787_550_897,
    },
  ];

  it("puts the latest build on the home page and in the navigation", async () => {
    vi.mocked(mockApi.me).mockResolvedValue(member as never);
    vi.mocked(mockApi.installerDownloads).mockResolvedValue(builds);
    mount("/");
    const btn = await screen.findByRole("link", {
      name: /Download installer v1\.2\.0\+14/,
    });
    expect(btn.getAttribute("href")).toBe(builds[0]!.url);
    expect(screen.getAllByRole("link", { name: "Installer" }).length).toBe(2);
  });

  it("lists every build on /installer, newest marked", async () => {
    vi.mocked(mockApi.me).mockResolvedValue(member as never);
    vi.mocked(mockApi.installerDownloads).mockResolvedValue(builds);
    mount("/installer");
    expect(
      await screen.findByRole("link", { name: "app-release.apk" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "installer-1.2.0.apk (latest)" }),
    ).toBeInTheDocument();
  });

  it("explains an empty list and an untrusted installer app differently", async () => {
    vi.mocked(mockApi.me).mockResolvedValue(member as never);
    vi.mocked(mockApi.installerDownloads).mockResolvedValue([]);
    mount("/installer");
    expect(
      await screen.findByText(/No installer build is published yet/),
    ).toBeInTheDocument();
    vi.mocked(mockApi.installerDownloads).mockRejectedValue(
      new (await import("../src/api")).ApiError(503, "unavailable", "x", {
        reason: "installer_untrusted",
      }),
    );
    mount("/installer");
    expect(
      await screen.findByText(/team is not admin-locked/),
    ).toBeInTheDocument();
  });

  it("surfaces an unrelated 503 as an error instead of an empty list", async () => {
    vi.mocked(mockApi.me).mockResolvedValue(member as never);
    vi.mocked(mockApi.installerDownloads).mockRejectedValue(
      new (await import("../src/api")).ApiError(503, "unavailable", "db down"),
    );
    mount("/installer");
    expect(await screen.findByRole("alert")).toHaveTextContent("db down");
  });

  it("denies /installer to pending members", async () => {
    vi.mocked(mockApi.me).mockResolvedValue({
      ...member,
      role: "pending",
    } as never);
    mount("/installer");
    await screen.findAllByRole("link", { name: "Events" });
    expect(screen.queryByRole("heading", { name: "Installer" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Installer" })).toBeNull();
  });

  it("stays quiet on the home page when no installer is served", async () => {
    vi.mocked(mockApi.me).mockResolvedValue(member as never);
    vi.mocked(mockApi.installerDownloads).mockRejectedValue(
      new (await import("../src/api")).ApiError(503, "unavailable", "x", {
        reason: "installer_untrusted",
      }),
    );
    mount("/");
    await screen.findAllByRole("link", { name: "Teams" });
    expect(screen.queryByText(/Download installer/)).toBeNull();
  });
});
