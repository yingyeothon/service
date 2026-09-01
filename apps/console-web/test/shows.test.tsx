import { MantineProvider } from "@mantine/core";
import { ModalsProvider } from "@mantine/modals";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../src/api";
import type { EventDetail, ShowDetail, ShowEntry } from "../src/types";

const mockApi = {
  me: vi.fn(),
  logout: vi.fn(),
  loginUrl: vi.fn(() => "/auth/github/start"),
  setUnauthorizedHandler: vi.fn(),
  shows: vi.fn(),
  show: vi.fn(),
  showEntries: vi.fn(),
  showEntry: vi.fn(),
  showSubmittable: vi.fn(),
  setEntryScreenshots: vi.fn(),
  likeEntry: vi.fn(),
  unlikeEntry: vi.fn(),
  updateEntry: vi.fn(),
  deleteEntry: vi.fn(),
  addEntryComment: vi.fn(),
  editEntryComment: vi.fn(),
  deleteEntryComment: vi.fn(),
  audit: vi.fn(),
  auditRow: vi.fn(),
  event: vi.fn(),
  eventRevisions: vi.fn(),
  eventRevision: vi.fn(),
  openShowForEvent: vi.fn(),
} as unknown as ApiClient;

vi.mock("../src/api", () => ({
  api: mockApi,
  ApiError: class extends Error {},
}));

const { ShowsPage } = await import("../src/pages/Shows");
const { ShowEntryPage } = await import("../src/pages/ShowEntry");
const { AuditPage } = await import("../src/pages/Audit");
const { ShowDetailPage } = await import("../src/pages/ShowDetail");
const { EventDetailPage } = await import("../src/pages/EventDetail");
const { theme } = await import("../src/theme");
const { AuthProvider } = await import("../src/auth");

const SHOW: ShowDetail = {
  id: "sh_1",
  title: "Hackathon 36",
  acl: "public",
  eventId: null,
  createdBy: "alice",
  createdAt: 0,
  updatedAt: 0,
  closedAt: null,
  bodyMd: "",
  closedBy: null,
  entryCount: 1,
  canWrite: true,
  canManage: true,
  grants: [],
};
const ENTRY: ShowEntry = {
  id: "se_1",
  showId: "sh_1",
  title: "Our game",
  bodyMd: "",
  createdBy: "bob",
  createdAt: 0,
  updatedAt: 0,
  target: {
    kind: "site",
    id: "st_1",
    name: "web",
    ref: null,
    available: true,
    url: "https://g.example/abc/",
  },
  shots: [],
  likes: 2,
  commentCount: 3,
  liked: false,
};
const EVENT = {
  id: "ev_1",
  title: "Hackathon 36",
  status: "closed",
  bodyMd: "body",
  place: "Seoul",
  placeUrl: null,
  durationHours: 8,
  voteUntil: 0,
  startsAt: 1,
  options: [],
  owner: "alice",
  mine: true,
  canEdit: true,
  revision: 2,
  createdAt: 0,
  updatedAt: 0,
  publishedAt: 1,
  cancelledAt: null,
  cancelledBy: null,
  posterUrl: null,
  showId: null,
  comments: [],
} as unknown as EventDetail;

function mount(path: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <MantineProvider theme={theme} forceColorScheme="light">
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[path]}>
          <AuthProvider client={mockApi}>
            <ModalsProvider>
              <Routes>
                <Route path="/shows" element={<ShowsPage />} />
                <Route path="/shows/:id" element={<ShowDetailPage />} />
                <Route
                  path="/shows/:id/entries/:eid"
                  element={<ShowEntryPage />}
                />
                <Route path="/audit" element={<AuditPage />} />
                <Route path="/events/:id" element={<EventDetailPage />} />
              </Routes>
            </ModalsProvider>
          </AuthProvider>
        </MemoryRouter>
      </QueryClientProvider>
    </MantineProvider>,
  );
}

describe("show pages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(mockApi.me).mockResolvedValue({
      id: "m_1",
      login: "alice",
      role: "member",
      via: "session",
    });
    vi.mocked(mockApi.shows).mockResolvedValue({ shows: [SHOW], next: null });
    vi.mocked(mockApi.show).mockResolvedValue(SHOW);
    vi.mocked(mockApi.showEntries).mockResolvedValue({
      entries: [ENTRY],
      next: null,
    });
    vi.mocked(mockApi.showSubmittable).mockResolvedValue([]);
    vi.mocked(mockApi.event).mockResolvedValue(EVENT);
    vi.mocked(mockApi.eventRevisions).mockResolvedValue([]);
    // A `queryFn` must never resolve `undefined` (`rules/workflow.md`); an
    // unset mock would, and the noise hides real failures.
    vi.mocked(mockApi.eventRevision).mockResolvedValue({
      revision: 1,
      editedBy: "alice",
      editedAt: 0,
      title: "t",
      bodyMd: "",
      posterKey: null,
      place: "Seoul",
      placeUrl: null,
      durationHours: 8,
    });
    vi.mocked(mockApi.showEntry).mockResolvedValue({
      ...ENTRY,
      comments: [
        {
          id: "sc_1",
          bodyMd: "nice",
          createdBy: "bob",
          createdAt: 0,
          updatedAt: 0,
          mine: false,
        },
      ],
      canWrite: true,
      canEdit: false,
      canModerate: false,
      canReact: true,
    });
    vi.mocked(mockApi.audit).mockResolvedValue({
      rows: [
        {
          id: "au_1",
          actor: "boss",
          action: "show.delete",
          target: "sh_1",
          at: 0,
        },
      ],
      next: null,
    });
  });

  it("lists shows with who may see them", async () => {
    mount("/shows");
    expect(await screen.findByText("Hackathon 36")).toBeTruthy();
    expect(screen.getByText("everyone")).toBeTruthy();
  });

  it("shows the wall, and asks the API for the order it renders", async () => {
    mount("/shows/sh_1");
    expect(await screen.findByText("Our game")).toBeTruthy();
    // The card carries the derived counts, not a stored one.
    expect(screen.getByText("2")).toBeTruthy();
    expect(screen.getByText("3")).toBeTruthy();
    expect(vi.mocked(mockApi.showEntries)).toHaveBeenCalledWith("sh_1", {
      sort: "new",
    });
    await userEvent.click(screen.getByText("Most liked"));
    expect(vi.mocked(mockApi.showEntries)).toHaveBeenCalledWith("sh_1", {
      sort: "likes",
    });
  });

  it("does not fetch the revision list until the history is opened", async () => {
    mount("/events/ev_1");
    expect(await screen.findByText("Page history")).toBeTruthy();
    // Conditionally mounted, not hidden: `Collapse` would keep the children
    // mounted and their queries would fire on every event page.
    expect(vi.mocked(mockApi.eventRevisions)).not.toHaveBeenCalled();
    await userEvent.click(screen.getByText("Page history"));
    expect(vi.mocked(mockApi.eventRevisions)).toHaveBeenCalledWith("ev_1");
  });

  it("draws entry controls from the entry-level flag, not the show-level one", async () => {
    mount("/shows/sh_1/entries/se_1");
    expect(await screen.findByText("Our game")).toBeTruthy();
    // `canWrite` is true (a grant holder may submit here) but `canEdit` is
    // false (this is somebody else's entry): offering Edit or the screenshot
    // field would be a button that always 403s.
    expect(screen.queryByText("Edit")).toBeNull();
    expect(screen.queryByText("Save screenshots")).toBeNull();
    // A comment they did not write, and they are not a moderator: no Delete.
    expect(screen.queryByText("Delete")).toBeNull();
    // Reacting is theirs, though.
    expect(screen.getByText("2")).toBeTruthy();
  });

  it("the audit page lists rows and never shows a detail until asked", async () => {
    mount("/audit");
    expect(await screen.findByText("show.delete")).toBeTruthy();
    expect(screen.getByText("boss")).toBeTruthy();
    expect(vi.mocked(mockApi.auditRow)).not.toHaveBeenCalled();
    await userEvent.click(screen.getByText("Detail"));
    expect(vi.mocked(mockApi.auditRow)).toHaveBeenCalledWith("au_1");
  });

  it("offers to open a show on a closed event, outside the owner panel", async () => {
    mount("/events/ev_1");
    // `closed` is exactly when the entries matter, and the owner panel is gone
    // by then — so the button must not live inside it.
    expect(await screen.findByText("Open a show for this event")).toBeTruthy();
  });
});
