import { screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../src/api";
import type { EventSummary } from "../src/types";

const mockApi = {
  me: vi.fn(),
  logout: vi.fn(),
  loginUrl: vi.fn(() => "/auth/github/start"),
  setUnauthorizedHandler: vi.fn(),
  events: vi.fn(),
  createEvent: vi.fn(),
} as unknown as ApiClient;

vi.mock("../src/api", () => ({
  api: mockApi,
  ApiError: class extends Error {},
}));

const { EventsPage } = await import("../src/pages/Events");
const { mount } = await import("./wrap");

const EVENTS: EventSummary[] = [
  {
    id: "ev_1",
    title: "Spring jam",
    status: "voting",
    place: "Seoul",
    durationHours: 24,
    voteUntil: 86400,
    startsAt: null,
    owner: "alice",
    mine: true,
    createdAt: 0,
    updatedAt: 0,
    publishedAt: 0,
    hasPoster: true,
  },
];

describe("EventsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(mockApi.events).mockResolvedValue(EVENTS);
  });

  it("lists events with their columns and links, offering creation to a member", async () => {
    vi.mocked(mockApi.me).mockResolvedValue({
      id: "u1",
      login: "alice",
      role: "member",
      via: "session",
    });
    mount(<EventsPage />, { client: mockApi });
    expect(
      await screen.findByRole("link", { name: "Spring jam" }),
    ).toHaveAttribute("href", "/events/ev_1");
    for (const col of ["Title", "Status", "When", "Place", "Owner"])
      expect(
        screen.getByRole("columnheader", { name: col }),
      ).toBeInTheDocument();
    expect(screen.getByText("voting")).toBeInTheDocument();
    expect(screen.getByText(/vote until/)).toBeInTheDocument();
    expect(screen.getByText(/poster/)).toBeInTheDocument();
    expect(
      await screen.findByRole("button", { name: "New event" }),
    ).toBeInTheDocument();
  });

  it("tells an anonymous visitor to sign in and hides creation", async () => {
    vi.mocked(mockApi.me).mockResolvedValue(null);
    mount(<EventsPage />, { client: mockApi });
    await screen.findByRole("link", { name: "Spring jam" });
    expect(
      await screen.findByText(/to see votes in progress/),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New event" })).toBeNull();
  });

  it("shows the empty state", async () => {
    vi.mocked(mockApi.me).mockResolvedValue(null);
    vi.mocked(mockApi.events).mockResolvedValue([]);
    mount(<EventsPage />, { client: mockApi });
    expect(await screen.findByText("No events.")).toBeInTheDocument();
  });
});
