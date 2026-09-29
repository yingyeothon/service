import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../src/api";
import type { AdminLimitRequestPage, LimitRequest } from "../src/types";

const mockApi = {
  me: vi.fn(),
  logout: vi.fn(),
  loginUrl: vi.fn(() => "/auth/github/start"),
  setUnauthorizedHandler: vi.fn(),
  adminLimitRequests: vi.fn(),
  approveLimitRequest: vi.fn(),
  rejectLimitRequest: vi.fn(),
} as unknown as ApiClient;

vi.mock("../src/api", () => ({
  api: mockApi,
  ApiError: class extends Error {},
}));

const { LimitRequestsPage } = await import("../src/pages/LimitRequests");
const { mount } = await import("./wrap");

const MiB = 1024 * 1024;
const now = Math.floor(Date.now() / 1000);

const request = (over: Partial<LimitRequest> = {}): LimitRequest => ({
  id: "lr_1",
  teamId: "team_1",
  teamName: "studio",
  scope: { kind: "bundle", id: "ab_1", name: "dungeon-maps" },
  key: "asset.bundleBytes",
  unit: "bytes",
  hard: 3 * 1024 * MiB,
  requestedValue: 256 * MiB,
  reason: "a season of maps",
  status: "pending",
  decidedValue: null,
  decisionNote: null,
  createdBy: "u1",
  createdByLogin: "alice",
  createdAt: now - 7200,
  decidedBy: null,
  decidedByLogin: null,
  decidedAt: null,
  ...over,
});

const page = (
  requests: LimitRequest[],
  over: Partial<AdminLimitRequestPage> = {},
): AdminLimitRequestPage => ({
  requests,
  next: null,
  pending: requests.filter((r) => r.status === "pending").length,
  oldestPendingAt: requests[0]?.createdAt ?? null,
  ...over,
});

async function rowAction(name: string, verb: string) {
  await userEvent.click(
    await screen.findByRole("button", { name: `Actions for ${name}` }),
  );
  await userEvent.click(await screen.findByRole("menuitem", { name: verb }));
}

describe("LimitRequestsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(mockApi.me).mockResolvedValue({
      id: "u9",
      login: "root",
      role: "admin",
      via: "session",
    });
    vi.mocked(mockApi.adminLimitRequests).mockResolvedValue(
      page([
        request(),
        request({
          id: "lr_2",
          scope: { kind: "channel", id: "auth_1", name: "login" },
          key: "channel.lifetime",
          unit: "seconds",
          hard: "unlimited",
          requestedValue: "unlimited",
          teamId: "team_2",
          teamName: "other",
          createdByLogin: "bob",
        }),
      ]),
    );
  });

  it("links a team-scoped request to the team", async () => {
    vi.mocked(mockApi.adminLimitRequests).mockResolvedValue(
      page([
        request({
          scope: { kind: "team", id: "team_1", name: "studio" },
          key: "team.projects",
          unit: "count",
          hard: 1000,
          requestedValue: 25,
        }),
      ]),
    );
    mount(<LimitRequestsPage />, { client: mockApi });
    expect(await screen.findByText("Projects")).toBeInTheDocument();
    expect(screen.getByText("25")).toBeInTheDocument();
    const links = screen.getAllByRole("link", { name: "studio" });
    for (const l of links) expect(l).toHaveAttribute("href", "/teams/team_1");
  });

  it("lists the pending queue with its team, scope, limit and requester", async () => {
    mount(<LimitRequestsPage />, { client: mockApi });
    expect(
      await screen.findByRole("heading", { name: "Limit requests" }),
    ).toBeInTheDocument();
    expect(await screen.findByText("dungeon-maps")).toBeInTheDocument();
    expect(mockApi.adminLimitRequests).toHaveBeenCalledWith({
      status: "pending",
      cursor: undefined,
    });
    for (const col of [
      "Team",
      "Scope",
      "Limit",
      "Requested",
      "Requester",
      "Status",
    ])
      expect(
        screen.getByRole("columnheader", { name: col }),
      ).toBeInTheDocument();
    expect(screen.getByText(/2 pending · oldest 2h ago/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "studio" })).toHaveAttribute(
      "href",
      "/teams/team_1",
    );
    expect(screen.getByRole("link", { name: "dungeon-maps" })).toHaveAttribute(
      "href",
      "/assets/ab_1",
    );
    expect(screen.getByRole("link", { name: "login" })).toHaveAttribute(
      "href",
      "/channels/auth_1",
    );
    expect(screen.getByText("Bundle size")).toBeInTheDocument();
    expect(screen.getByText("256 MiB")).toBeInTheDocument();
    expect(screen.getByText("Lifetime")).toBeInTheDocument();
    expect(screen.getByText("No expiry")).toBeInTheDocument();
    expect(screen.getByText("bob")).toBeInTheDocument();
  });

  it("approves with an adjusted value in another unit", async () => {
    vi.mocked(mockApi.approveLimitRequest).mockResolvedValue(
      request({ status: "approved", decidedValue: 128 * MiB }),
    );
    mount(<LimitRequestsPage />, { client: mockApi });
    await rowAction("Bundle size of dungeon-maps", "Approve");
    const drawer = await screen.findByRole("dialog");
    // The reason is on screen before the decision.
    expect(within(drawer).getByText("a season of maps")).toBeInTheDocument();
    const value = within(drawer).getByRole("textbox", { name: /^Grant/ });
    expect(value).toHaveValue("256");
    expect(within(drawer).getByLabelText("Unit")).toHaveValue("MiB");
    await userEvent.clear(value);
    await userEvent.type(value, "128");
    await userEvent.type(within(drawer).getByLabelText("Note"), "half for now");
    await userEvent.click(
      within(drawer).getByRole("button", { name: "Approve request" }),
    );
    await waitFor(() =>
      expect(mockApi.approveLimitRequest).toHaveBeenCalledWith("lr_1", {
        value: 128 * MiB,
        note: "half for now",
      }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // The queue and the menu badge are asked again.
    await waitFor(() =>
      expect(mockApi.adminLimitRequests).toHaveBeenCalledTimes(2),
    );
  });

  it("approves as requested with an empty body and refuses above the ceiling", async () => {
    vi.mocked(mockApi.approveLimitRequest).mockResolvedValue(
      request({ status: "approved", decidedValue: 256 * MiB }),
    );
    mount(<LimitRequestsPage />, { client: mockApi });
    await rowAction("Bundle size of dungeon-maps", "Approve");
    const drawer = await screen.findByRole("dialog");
    const value = within(drawer).getByRole("textbox", { name: /^Grant/ });
    await userEvent.clear(value);
    await userEvent.type(value, "4");
    await userEvent.selectOptions(within(drawer).getByLabelText("Unit"), "GiB");
    expect(within(drawer).getByText("At most 3 GiB.")).toBeInTheDocument();
    const approve = within(drawer).getByRole("button", {
      name: "Approve request",
    });
    expect(approve).toBeDisabled();
    await userEvent.selectOptions(within(drawer).getByLabelText("Unit"), "MiB");
    await userEvent.clear(value);
    await userEvent.type(value, "256");
    await userEvent.click(approve);
    await waitFor(() =>
      expect(mockApi.approveLimitRequest).toHaveBeenCalledWith("lr_1", {}),
    );
  });

  it("approves no expiry without a number", async () => {
    vi.mocked(mockApi.approveLimitRequest).mockResolvedValue(
      request({ id: "lr_2", key: "channel.lifetime", status: "approved" }),
    );
    mount(<LimitRequestsPage />, { client: mockApi });
    await rowAction("Lifetime of login", "Approve");
    const drawer = await screen.findByRole("dialog");
    expect(
      within(drawer).queryByRole("textbox", { name: /^Grant/ }),
    ).toBeNull();
    await userEvent.click(
      within(drawer).getByRole("button", { name: "Approve request" }),
    );
    await waitFor(() =>
      expect(mockApi.approveLimitRequest).toHaveBeenCalledWith("lr_2", {}),
    );
  });

  it("rejects with the note the confirm requires", async () => {
    vi.mocked(mockApi.rejectLimitRequest).mockResolvedValue(
      request({ status: "rejected", decisionNote: "too big" }),
    );
    mount(<LimitRequestsPage />, { client: mockApi });
    await rowAction("Bundle size of dungeon-maps", "Reject");
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/a season of maps/)).toBeInTheDocument();
    const reject = within(dialog).getByRole("button", {
      name: "Reject request",
    });
    expect(reject).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText("Reason"), "too big");
    await userEvent.click(reject);
    await waitFor(() =>
      expect(mockApi.rejectLimitRequest).toHaveBeenCalledWith(
        "lr_1",
        "too big",
      ),
    );
  });

  it("filters by status and pages with Load more", async () => {
    vi.mocked(mockApi.adminLimitRequests).mockImplementation((q = {}) =>
      Promise.resolve(
        q.cursor
          ? page(
              [
                request({
                  id: "lr_9",
                  status: "approved",
                  scope: { kind: "project", id: "prj_1", name: "older" },
                }),
              ],
              {
                pending: 0,
              },
            )
          : q.status === "approved"
            ? page(
                [
                  request({
                    status: "approved",
                    decidedValue: 256 * MiB,
                    decidedAt: now - 60,
                  }),
                ],
                { next: "lr_1", pending: 0 },
              )
            : page([request()]),
      ),
    );
    mount(<LimitRequestsPage />, { client: mockApi });
    await screen.findByText("dungeon-maps");
    await userEvent.selectOptions(screen.getByLabelText("Status"), "approved");
    await waitFor(() =>
      expect(mockApi.adminLimitRequests).toHaveBeenCalledWith({
        status: "approved",
        cursor: undefined,
      }),
    );
    expect(
      await within(screen.getByRole("table")).findByText("approved"),
    ).toBeInTheDocument();
    await userEvent.click(
      await screen.findByRole("button", { name: "Load more" }),
    );
    expect(await screen.findByText("older")).toBeInTheDocument();
    expect(mockApi.adminLimitRequests).toHaveBeenLastCalledWith({
      status: "approved",
      cursor: "lr_1",
    });
    expect(screen.getByRole("link", { name: "older" })).toHaveAttribute(
      "href",
      "/teams/team_1/projects/prj_1/assets",
    );
    // A decided row offers its details, not the decision verbs.
    await rowAction("Bundle size of dungeon-maps", "Details");
    const drawer = await screen.findByRole("dialog");
    expect(within(drawer).getByText("a season of maps")).toBeInTheDocument();
    // Requested and granted.
    expect(within(drawer).getAllByText("256 MiB")).toHaveLength(2);
  });
});
