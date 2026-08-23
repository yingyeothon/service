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
  tokens: vi.fn(),
  members: vi.fn(),
  setUnauthorizedHandler: vi.fn(),
} as unknown as ApiClient;

vi.mock("../src/api", () => ({
  api: mockApi,
  ApiError: class extends Error {},
}));

const { App } = await import("../src/App");
const { AuthProvider } = await import("../src/auth");

function mount(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider client={mockApi}>
        <App />
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe("App", () => {
  beforeEach(() => {
    vi.mocked(mockApi.events).mockResolvedValue([]);
    vi.mocked(mockApi.channels).mockResolvedValue([]);
    vi.mocked(mockApi.tokens).mockResolvedValue([]);
    vi.mocked(mockApi.members).mockResolvedValue([]);
  });

  it("asks anonymous visitors to sign in on protected pages, with next= preserved", async () => {
    vi.mocked(mockApi.me).mockResolvedValue(null);
    mount("/channels?kind=auth");
    expect(await screen.findByText("Sign in to continue.")).toBeInTheDocument();
    const link = screen.getByRole("link", { name: "Sign in with GitHub" });
    expect(link.getAttribute("href")).toBe(
      "/auth/github/start?next=%2Fchannels%3Fkind%3Dauth",
    );
    expect(screen.queryByRole("link", { name: "Channels" })).toBeNull();
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
        status: "published",
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
    expect(screen.getByText("published")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New event" })).toBeNull();
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
