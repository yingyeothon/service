import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes, useLocation } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../src/api";
import type { LimitRequest, TeamDetail, TeamMember } from "../src/types";

const mockApi = {
  me: vi.fn(),
  logout: vi.fn(),
  loginUrl: vi.fn(() => "/auth/github/start"),
  setUnauthorizedHandler: vi.fn(),
  team: vi.fn(),
  teams: vi.fn(),
  teamMembers: vi.fn(),
  setTeamMemberRole: vi.fn(),
  removeTeamMember: vi.fn(),
  members: vi.fn(),
  projects: vi.fn(),
  limitRequests: vi.fn(),
  cancelLimitRequest: vi.fn(),
  limits: vi.fn(),
} as unknown as ApiClient;

vi.mock("../src/api", () => ({
  api: mockApi,
  ApiError: class extends Error {},
}));

const { TeamPage } = await import("../src/pages/Team");
const { TeamsPage } = await import("../src/pages/Teams");
const { mount: mountWith } = await import("./wrap");

const TEAM: TeamDetail = {
  id: "team_1",
  name: "studio",
  role: "owner",
  description: "We make **games**",
  adminLocked: false,
  createdBy: "alice",
  createdAt: 0,
  updatedAt: 0,
  counts: { owners: 1, members: 1, pending: 1, projects: 0 },
};

const MEMBERS: TeamMember[] = [
  {
    id: "m_1",
    login: "alice",
    platformRole: "member",
    role: "owner",
    state: "active",
    requestedAt: 0,
    decidedAt: 0,
    decidedBy: null,
  },
  {
    id: "m_2",
    login: "bob",
    platformRole: "member",
    role: "member",
    state: "active",
    requestedAt: 0,
    decidedAt: 0,
    decidedBy: "alice",
  },
  {
    id: "m_3",
    login: "carol",
    platformRole: "member",
    role: "pending",
    state: "active",
    requestedAt: 0,
    decidedAt: null,
    decidedBy: null,
  },
];

/** Prints the pathname so a test can pin where a redirect landed. */
function LocationProbe() {
  return <div data-testid="location">{useLocation().pathname}</div>;
}

function mount(path: string) {
  return mountWith(
    <>
      <Routes>
        <Route path="/teams" element={<TeamsPage />} />
        <Route path="/teams/:team" element={<TeamPage />} />
        <Route path="/teams/:team/:tab" element={<TeamPage />} />
      </Routes>
      <LocationProbe />
    </>,
    { client: mockApi, path },
  );
}

/** Opens a row's menu and picks a verb, then confirms it in the modal. */
async function rowVerb(name: string, verb: string) {
  await userEvent.click(
    await screen.findByRole("button", { name: `Actions for ${name}` }),
  );
  await userEvent.click(await screen.findByRole("menuitem", { name: verb }));
  const dialog = await screen.findByRole("dialog");
  await userEvent.click(within(dialog).getByRole("button", { name: verb }));
}

describe("TeamPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(mockApi.me).mockResolvedValue({
      id: "m_1",
      login: "alice",
      role: "member",
      via: "session",
    });
    vi.mocked(mockApi.team).mockResolvedValue(TEAM);
    vi.mocked(mockApi.teamMembers).mockResolvedValue(MEMBERS);
    vi.mocked(mockApi.projects).mockResolvedValue([]);
    vi.mocked(mockApi.teams).mockResolvedValue([]);
  });

  it("opens the edit drawer for an owner's bookmarked /settings and lands on the first tab", async () => {
    mount("/teams/team_1/settings");
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByRole("heading", { name: "Edit team" }),
    ).toBeInTheDocument();
    expect(within(dialog).getByDisplayValue("studio")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Projects" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await waitFor(() =>
      expect(screen.getByTestId("location")).toHaveTextContent(
        /^\/teams\/team_1$/,
      ),
    );
  });

  it("sends a member's /settings and an unknown tab to the first tab without a drawer", async () => {
    vi.mocked(mockApi.team).mockResolvedValue({ ...TEAM, role: "member" });
    mount("/teams/team_1/settings");
    expect(
      await screen.findByRole("tab", { name: "Projects" }),
    ).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByRole("dialog")).toBeNull();
    cleanup();
    mount("/teams/team_1/nope");
    expect(
      await screen.findByRole("tab", { name: "Projects" }),
    ).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() =>
      expect(screen.getByTestId("location")).toHaveTextContent(
        /^\/teams\/team_1$/,
      ),
    );
  });

  it("shows the team's project limit under the projects with the request button", async () => {
    vi.mocked(mockApi.limits).mockResolvedValue({
      scope: { kind: "team", id: "team_1" },
      teamId: "team_1",
      limits: [
        {
          key: "team.projects",
          unit: "count",
          soft: 20,
          hard: 1000,
          effective: 20,
          usage: 20,
          step: 5,
          next: 25,
          override: null,
        },
      ],
      pending: [],
    });
    mount("/teams/team_1");
    expect(
      await screen.findByRole("heading", { name: "Limits" }),
    ).toBeInTheDocument();
    expect(mockApi.limits).toHaveBeenCalledWith("team:team_1");
    expect(
      await screen.findByText("Projects", { selector: "td" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Request increase" }),
    ).toBeInTheDocument();
  });

  it("renders the description as markdown and lets an owner approve a request", async () => {
    vi.mocked(mockApi.setTeamMemberRole).mockResolvedValue({
      ...MEMBERS[2]!,
      role: "member",
    });
    mount("/teams/team_1/members");
    expect(await screen.findByText("games")).toBeInTheDocument();
    expect(screen.getByText("games").tagName).toBe("STRONG");
    await userEvent.click(
      await screen.findByRole("button", { name: "Approve" }),
    );
    expect(mockApi.setTeamMemberRole).toHaveBeenCalledWith(
      "team_1",
      "m_3",
      "member",
    );
  });

  it("kicking a member lists the channels whose secrets they still know", async () => {
    vi.mocked(mockApi.removeTeamMember).mockResolvedValue({
      removed: "m_2",
      action: "kick",
      rotate: [{ id: "auth_9", kind: "auth", name: "login" }],
      encryptedBundles: [{ id: "ab_7", name: "content" }],
    });
    mount("/teams/team_1/members");
    await rowVerb("bob", "Kick");
    expect(
      await screen.findByText(/still knows the credentials/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "login" }).getAttribute("href"),
    ).toBe("/channels/auth_9");
    // The encrypted bundles whose key the member could have read.
    expect(screen.getByText(/could have read the key/)).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "content" }).getAttribute("href"),
    ).toBe("/assets/ab_7");
    expect(mockApi.removeTeamMember).toHaveBeenCalledWith("team_1", "m_2");
  });

  it("TeamsPage asks the server for the clicked order and the typed search", async () => {
    vi.mocked(mockApi.teams).mockResolvedValue([
      {
        ...TEAM,
        id: "team_1",
        name: "games",
        role: "owner",
        createdBy: "alice",
        updatedAt: 10,
      },
    ]);
    mount("/teams");
    expect(
      await screen.findByRole("link", { name: "games" }),
    ).toBeInTheDocument();
    expect(mockApi.teams).toHaveBeenLastCalledWith(undefined, {});
    await userEvent.click(screen.getByRole("button", { name: "Updated" }));
    await waitFor(() =>
      expect(mockApi.teams).toHaveBeenLastCalledWith(undefined, {
        sort: "updatedAt",
        order: "desc",
      }),
    );
    expect(
      screen.getByRole("columnheader", { name: "Updated" }),
    ).toHaveAttribute("aria-sort", "descending");
    vi.mocked(mockApi.teams).mockResolvedValue([]);
    await userEvent.type(
      screen.getByRole("searchbox", { name: "Search" }),
      "dun",
    );
    await waitFor(() =>
      expect(mockApi.teams).toHaveBeenLastCalledWith(undefined, {
        sort: "updatedAt",
        order: "desc",
        q: "dun",
      }),
    );
    expect(await screen.findByText("No rows match “dun”.")).toBeInTheDocument();
    // Debounced: the intermediate prefixes never reach the server.
    for (const partial of ["d", "du"])
      expect(mockApi.teams).not.toHaveBeenCalledWith(
        undefined,
        expect.objectContaining({ q: partial }),
      );
  });

  it("leaving hands the rotation list to the Teams page", async () => {
    vi.mocked(mockApi.removeTeamMember).mockResolvedValue({
      removed: "m_1",
      action: "leave",
      rotate: [{ id: "q_1", kind: "q", name: "dungeon" }],
      encryptedBundles: [],
    });
    mount("/teams/team_1/members");
    // Leaving is the page's verb, not a row's: it sits in the header menu.
    await userEvent.click(
      await screen.findByRole("button", { name: "More actions" }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Leave team" }),
    );
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Leave team" }),
    );
    expect(await screen.findByText("You left studio.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "dungeon" })).toBeInTheDocument();
  });

  it("shows a pending requester only the name and a withdraw button", async () => {
    vi.mocked(mockApi.team).mockResolvedValue({
      id: "team_1",
      name: "studio",
      role: "pending",
    });
    mount("/teams/team_1");
    expect(await screen.findByText(/waiting for an owner/)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Withdraw request" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Members" })).toBeNull();
    expect(mockApi.teamMembers).not.toHaveBeenCalled();
  });

  it("gives a seatless platform admin the read-only view with the appoint form", async () => {
    vi.mocked(mockApi.me).mockResolvedValue({
      id: "m_admin",
      login: "root",
      role: "admin",
      via: "session",
    });
    vi.mocked(mockApi.team).mockResolvedValue({ ...TEAM, role: "admin" });
    vi.mocked(mockApi.members).mockResolvedValue([
      {
        id: "m_2",
        login: "bob",
        role: "member",
        createdAt: 0,
        approvedAt: 0,
        approvedBy: null,
      },
    ]);
    mount("/teams/team_1/members");
    expect(await screen.findByText(/without a seat/)).toBeInTheDocument();
    expect(
      await screen.findByRole("button", { name: "Appoint owner" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Actions for/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add member" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    // No drawer, so the delete verb sits in the overflow menu for the admin.
    await userEvent.click(screen.getByRole("button", { name: "More actions" }));
    expect(
      await screen.findByRole("menuitem", { name: "Delete team" }),
    ).toBeInTheDocument();
  });

  it("lists the team's limit requests and lets an owner cancel a pending one", async () => {
    const req = (over: Partial<LimitRequest>): LimitRequest => ({
      id: "lr_1",
      teamId: "team_1",
      teamName: "studio",
      scope: { kind: "bundle", id: "ab_1", name: "maps" },
      key: "asset.filesPerVersion",
      unit: "count",
      hard: 5000,
      requestedValue: 1000,
      reason: "levels",
      status: "pending",
      decidedValue: null,
      decisionNote: null,
      createdBy: "m_2",
      createdByLogin: "bob",
      createdAt: 0,
      decidedBy: null,
      decidedByLogin: null,
      decidedAt: null,
      ...over,
    });
    vi.mocked(mockApi.limitRequests)
      .mockResolvedValueOnce({
        requests: [
          req({}),
          req({
            id: "lr_0",
            key: "channel.lifetime",
            unit: "seconds",
            hard: "unlimited",
            requestedValue: "unlimited",
            scope: { kind: "channel", id: "auth_1", name: "login" },
            status: "rejected",
            decidedBy: "u9",
            decidedByLogin: "root",
            decisionNote: "use extend for a week",
            decidedAt: 10,
          }),
        ],
        next: "lr_0",
      })
      .mockResolvedValueOnce({
        requests: [
          req({
            id: "lr_a",
            key: "asset.bundleBytes",
            unit: "bytes",
            hard: 3 * 1024 * 1024 * 1024,
            requestedValue: 64 * 1024 * 1024,
            status: "approved",
            decidedValue: 64 * 1024 * 1024,
            decidedAt: 5,
          }),
        ],
        next: null,
      })
      .mockResolvedValue({ requests: [], next: null });
    vi.mocked(mockApi.cancelLimitRequest).mockResolvedValue(
      req({ status: "cancelled" }),
    );
    mount("/teams/team_1/limit-requests");
    expect(
      await screen.findByRole("tab", { name: "Limit requests" }),
    ).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByText("Files per version")).toBeInTheDocument();
    expect(mockApi.limitRequests).toHaveBeenCalledWith("team_1", {
      cursor: undefined,
    });
    for (const col of ["Limit", "Scope", "Requested", "Requester", "Status"])
      expect(
        screen.getByRole("columnheader", { name: col }),
      ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "login" })).toHaveAttribute(
      "href",
      "/channels/auth_1",
    );
    expect(screen.getByText("No expiry")).toBeInTheDocument();
    // A decided row: the admin's decision is readable, and nothing to cancel.
    await userEvent.click(
      screen.getByRole("button", { name: "Actions for Lifetime of login" }),
    );
    expect(
      screen.queryByRole("menuitem", { name: "Cancel request" }),
    ).toBeNull();
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Details" }),
    );
    const details = await screen.findByRole("dialog");
    expect(within(details).getByText("rejected")).toBeInTheDocument();
    expect(within(details).getByText(/by root$/)).toBeInTheDocument();
    expect(
      within(details).getByText("use extend for a week"),
    ).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await userEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(await screen.findByText("Bundle size")).toBeInTheDocument();
    expect(mockApi.limitRequests).toHaveBeenLastCalledWith("team_1", {
      cursor: "lr_0",
    });
    await rowVerb("Files per version of maps", "Cancel request");
    await waitFor(() =>
      expect(mockApi.cancelLimitRequest).toHaveBeenCalledWith("lr_1"),
    );
  });
});
