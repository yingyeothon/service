import { MantineProvider } from "@mantine/core";
import { ModalsProvider } from "@mantine/modals";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../src/api";
import type { EventDetail, Role } from "../src/types";
import { fmtTime } from "../src/lib/format";

const mockApi = {
  me: vi.fn(),
  logout: vi.fn(),
  loginUrl: vi.fn(() => "/auth/github/start"),
  setUnauthorizedHandler: vi.fn(),
  event: vi.fn(),
  eventRevisions: vi.fn(),
  eventRevision: vi.fn(),
  closeEventVote: vi.fn(),
  openShowForEvent: vi.fn(),
  showEntries: vi.fn(),
} as unknown as ApiClient;

vi.mock("../src/api", () => ({
  api: mockApi,
  ApiError: class extends Error {},
}));

const { EventDetailPage } = await import("../src/pages/EventDetail");
const { theme } = await import("../src/theme");
const { AuthProvider } = await import("../src/auth");

const HOUR = 3600;
/** A running vote with two candidates; the later one leads 2–0. */
const VOTING = {
  id: "ev_1",
  title: "Hackathon 36",
  status: "voting",
  bodyMd: "",
  place: "Seoul",
  placeUrl: null,
  durationHours: 8,
  voteUntil: 100 * HOUR,
  startsAt: null,
  options: [
    { id: "eo_1", startsAt: 200 * HOUR, mine: false },
    { id: "eo_2", startsAt: 300 * HOUR, mine: true },
  ],
  owner: "alice",
  mine: false,
  canEdit: true,
  revision: 1,
  createdAt: 0,
  updatedAt: 0,
  publishedAt: 1,
  cancelledAt: null,
  cancelledBy: null,
  voteClosedAt: null,
  voteClosedBy: null,
  voteClosedReason: null,
  posterUrl: null,
  showId: null,
  comments: [],
} as unknown as EventDetail;

const FORCED = {
  ...VOTING,
  status: "waiting",
  startsAt: 200 * HOUR,
  voteUntil: 50 * HOUR,
  voters: 2,
  options: [
    { id: "eo_1", startsAt: 200 * HOUR, mine: false, votes: 0 },
    { id: "eo_2", startsAt: 300 * HOUR, mine: true, votes: 2 },
  ],
  voteClosedAt: 50 * HOUR,
  voteClosedBy: "boss",
  voteClosedReason: "the venue moved its deadline",
  voteOverridden: true,
} as unknown as EventDetail;

/** The common early close: the admin let the standing rule decide. */
const CLOSED_ON_TALLY = {
  ...FORCED,
  startsAt: 300 * HOUR,
  voteOverridden: false,
} as unknown as EventDetail;

function mount() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <MantineProvider theme={theme} forceColorScheme="light">
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/events/ev_1"]}>
          <AuthProvider client={mockApi}>
            <ModalsProvider>
              <Routes>
                <Route path="/events/:id" element={<EventDetailPage />} />
              </Routes>
            </ModalsProvider>
          </AuthProvider>
        </MemoryRouter>
      </QueryClientProvider>
    </MantineProvider>,
  );
}

const signedInAs = (role: Role) =>
  vi.mocked(mockApi.me).mockResolvedValue({
    id: "m_1",
    login: role === "admin" ? "boss" : "alice",
    role,
    via: "session",
  });

describe("closing a date vote early", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(mockApi.event).mockResolvedValue(VOTING);
    vi.mocked(mockApi.eventRevisions).mockResolvedValue([]);
    vi.mocked(mockApi.closeEventVote).mockResolvedValue(FORCED);
  });

  it("is offered to a platform admin on a running vote only", async () => {
    signedInAs("admin");
    mount();
    expect(await screen.findByText("Close the vote now (admin)")).toBeTruthy();
  });

  it("is hidden from the owner and from a vote that is already decided", async () => {
    // The owner may edit and cancel their event, but not overrule the vote.
    signedInAs("member");
    const owned = mount();
    expect(
      await screen.findByRole("heading", { level: 1, name: "Hackathon 36" }),
    ).toBeTruthy();
    expect(screen.queryByText("Close the vote now (admin)")).toBeNull();
    owned.unmount();

    signedInAs("admin");
    vi.mocked(mockApi.event).mockResolvedValue(FORCED);
    mount();
    expect(
      await screen.findByRole("heading", { level: 1, name: "Hackathon 36" }),
    ).toBeTruthy();
    expect(screen.queryByText("Close the vote now (admin)")).toBeNull();
  });

  it("sends the reason, and the standing rule unless a date is picked", async () => {
    signedInAs("admin");
    mount();
    await userEvent.click(await screen.findByText("Close the vote"));
    // The confirm is disabled until a reason is typed — assert the attribute,
    // not just that nothing was sent: the panel's own `reason === undefined`
    // guard would swallow the call even with `required` dropped.
    expect(
      (await screen.findByText("Yes, close it")).closest("button")?.disabled,
    ).toBe(true);
    await userEvent.click(screen.getByText("Yes, close it"));
    expect(vi.mocked(mockApi.closeEventVote)).not.toHaveBeenCalled();
    await userEvent.type(
      await screen.findByLabelText("Reason"),
      "the venue moved its deadline",
    );
    await userEvent.click(screen.getByText("Yes, close it"));
    // No option picked: `optionId` is omitted, never sent as an empty string,
    // which the API would reject.
    expect(vi.mocked(mockApi.closeEventVote)).toHaveBeenCalledWith(
      "ev_1",
      "the venue moved its deadline",
      undefined,
    );
  });

  it("sends the picked option id when a date is chosen", async () => {
    signedInAs("admin");
    mount();
    await screen.findByText("Close the vote now (admin)");
    // The standing-rule entry carries `value=""`; picking a real date must
    // send its id, and picking nothing must never send that empty string.
    // Mantine puts the same aria-label on the listbox it opens, so take the input.
    // Mantine's combobox opens on a raw click; `userEvent`'s pointer-event
    // checks never get it open under jsdom. It puts the same aria-label on
    // the listbox it opens, so take the input.
    fireEvent.click(screen.getAllByLabelText("Decided date")[0]!);
    // Read the options synchronously: awaiting lets React flush a re-render
    // that closes the dropdown. Scope to them, too — the panel above renders
    // the same candidate times.
    // A raw query, not `getAllByRole`: Mantine's dropdown sits under a hidden
    // portal wrapper, so it is out of the accessibility tree the role queries
    // walk, while still being present and clickable.
    const options = [...document.querySelectorAll('[role="option"]')];
    expect(options.map((o) => o.getAttribute("value"))).toEqual([
      "",
      "eo_1",
      "eo_2",
    ]);
    fireEvent.click(
      options.find((o) => o.textContent === fmtTime(200 * HOUR))!,
    );
    await userEvent.click(screen.getByText("Close the vote"));
    await userEvent.type(await screen.findByLabelText("Reason"), "hall only");
    await userEvent.click(screen.getByText("Yes, close it"));
    expect(vi.mocked(mockApi.closeEventVote)).toHaveBeenCalledWith(
      "ev_1",
      "hall only",
      "eo_1",
    );
  });

  it("tells every reader that the vote was cut short, and why", async () => {
    signedInAs("member");
    vi.mocked(mockApi.event).mockResolvedValue(FORCED);
    mount();
    expect(await screen.findByText(/Vote closed early by boss/)).toBeTruthy();
    expect(screen.getByText(/the venue moved its deadline/)).toBeTruthy();
    // This one really was overridden, so say so and drop the tie rule.
    expect(
      screen.getByText(/The date was chosen, not the one the votes point to/),
    ).toBeTruthy();
    expect(screen.getByText(/an admin picked this date/)).toBeTruthy();
    expect(screen.queryByText(/ties go to the earliest date/)).toBeNull();
  });

  it("does not claim an admin picked the date when the tally did", async () => {
    signedInAs("member");
    vi.mocked(mockApi.event).mockResolvedValue(CLOSED_ON_TALLY);
    mount();
    // Ending a vote early usually leaves the standing rule in charge; the tie
    // rule is then the only thing that explains the date, so it must stay.
    expect(await screen.findByText(/Vote closed early by boss/)).toBeTruthy();
    expect(screen.getByText(/ties go to the earliest date/)).toBeTruthy();
    expect(screen.queryByText(/an admin picked this date/)).toBeNull();
    expect(
      screen.queryByText(/The date was chosen, not the one the votes point to/),
    ).toBeNull();
  });
});
