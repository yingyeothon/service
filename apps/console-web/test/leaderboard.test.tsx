import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../src/api";
import type { LbScorePage, LeaderboardDetail, TeamDetail } from "../src/types";

/*
 * The board page (`/leaderboards/:id`): what a member sees and may do. The
 * page has **no** control that writes a score — that is the resource's
 * defining property (owner decision 2026-09-09) — so the tests pin the two
 * deletes, the bucket selector and the paging instead.
 */

const mockApi = {
  me: vi.fn(),
  logout: vi.fn(),
  loginUrl: vi.fn(() => "/auth/github/start"),
  setUnauthorizedHandler: vi.fn(),
  team: vi.fn(),
  leaderboard: vi.fn(),
  updateLeaderboard: vi.fn(),
  deleteLeaderboard: vi.fn(),
  lbScores: vi.fn(),
  deleteLbScore: vi.fn(),
  deleteLbPeriod: vi.fn(),
} as unknown as ApiClient;

vi.mock("../src/api", () => ({
  api: mockApi,
  ApiError: class extends Error {
    constructor(
      readonly status: number,
      readonly code: string,
      message: string,
    ) {
      super(message);
    }
  },
}));

const { LeaderboardPage, bucketOptions, periodKeyAt } =
  await import("../src/pages/Leaderboard");
const { mount } = await import("./wrap");

const TEAM: TeamDetail = { id: "team_1", name: "studio", role: "member" };
const NOW = Math.floor(Date.now() / 1000);
const OWNER_A = "a".repeat(32);
const OWNER_B = "b".repeat(32);
const BOARD: LeaderboardDetail = {
  id: "lb_1",
  name: "highscores",
  description: "the ladder",
  submit: "owner",
  rule: "best",
  order: "desc",
  periods: ["alltime", "daily"],
  maxEntries: 2000,
  retainPeriods: 4,
  period: "alltime",
  periodKey: "",
  scores: 2,
  teamId: "team_1",
  teamName: "studio",
  projectId: "prj_1",
  projectName: "dungeon",
  createdBy: "alice",
  createdAt: 0,
  updatedAt: 0,
  api: {
    configured: true,
    baseUrl: "https://doc-dev.example",
    metaPath: "/lb/lb_1",
    namePath: "/lb/highscores",
    topPath: "/lb/lb_1/top",
    scorePath: "/lb/lb_1/scores/{ownerId}",
  },
};
const PAGE: LbScorePage = {
  period: "alltime",
  periodKey: "",
  total: 2,
  scores: [
    {
      rank: 1,
      owner: OWNER_A,
      score: 250,
      meta: '{"name":"A"}',
      channelId: "auth_1",
      updatedAt: NOW - 120,
    },
    {
      rank: 1,
      owner: OWNER_B,
      score: 250,
      meta: null,
      channelId: null,
      updatedAt: NOW - 60,
    },
  ],
};

function open(board = BOARD) {
  vi.mocked(mockApi.leaderboard).mockResolvedValue(board);
  return mount(
    <Routes>
      <Route path="/leaderboards/:id" element={<LeaderboardPage />} />
      <Route
        path="/teams/:team/projects/:prj/:tab"
        element={<p>project tab</p>}
      />
    </Routes>,
    { client: mockApi, path: "/leaderboards/lb_1" },
  );
}

const headers = () =>
  screen.getAllByRole("columnheader").map((h) => h.textContent);
const rowOf = (text: string) => screen.getByText(text).closest("tr")!;
const cells = (tr: HTMLElement) =>
  within(tr)
    .getAllByRole("cell")
    .map((c) => c.textContent);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(mockApi.me).mockResolvedValue({
    id: "u1",
    login: "alice",
    role: "member",
    via: "session",
  });
  vi.mocked(mockApi.team).mockResolvedValue(TEAM);
  vi.mocked(mockApi.lbScores).mockResolvedValue(PAGE);
});

describe("LeaderboardPage", () => {
  it("shows the shape, the API block and one bucket's ranked scores", async () => {
    open();
    expect(
      await screen.findByRole("heading", { name: "highscores" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "dungeon" })).toHaveAttribute(
      "href",
      "/teams/team_1/projects/prj_1",
    );
    expect(screen.getByText("submit: owner")).toBeInTheDocument();
    expect(
      screen.getByText(/alltime, daily · at most 2000 per period/),
    ).toBeInTheDocument();
    // One copyable block, `name=value` lines.
    expect(screen.getByLabelText("LB API").textContent).toBe(
      [
        "base=https://doc-dev.example",
        "meta=/lb/lb_1",
        "name=/lb/highscores",
        "top=/lb/lb_1/top",
        "score=/lb/lb_1/scores/{ownerId}",
      ].join("\n"),
    );
    expect(await screen.findByText(OWNER_A)).toBeInTheDocument();
    expect(headers()).toEqual([
      "Rank",
      "Owner",
      "Score",
      "Meta",
      "Channel",
      "Updated",
      "Actions",
    ]);
    // Equal scores share a rank, and `meta` is rendered as it was stored.
    expect(cells(rowOf(OWNER_A)).slice(0, 5)).toEqual([
      "1",
      OWNER_A,
      "250",
      '{"name":"A"}',
      "auth_1",
    ]);
    expect(cells(rowOf(OWNER_B)).slice(0, 5)).toEqual([
      "1",
      OWNER_B,
      "250",
      "—",
      "—",
    ]);
    expect(screen.getByText("1–2 of 2")).toBeInTheDocument();
    // The default bucket is the server's: no `period` goes on the request.
    expect(mockApi.lbScores).toHaveBeenCalledWith("lb_1", { limit: 50 });
  });

  it("has no control that writes a score", async () => {
    open();
    await screen.findByText(OWNER_A);
    for (const name of [
      /submit/i,
      /new score/i,
      /put score/i,
      /edit score/i,
      /add score/i,
    ])
      expect(screen.queryByRole("button", { name })).toBeNull();
    expect(mockApi).not.toHaveProperty("putLbScore");
  });

  it("says that the console never writes a score", async () => {
    open();
    expect(
      await screen.findByText(/console never writes a score/i),
    ).toBeInTheDocument();
  });

  it("switches bucket by period name or past key and resets the page", async () => {
    open();
    await screen.findByText(OWNER_A);
    const select = screen.getByLabelText("Period");
    // The live bucket is offered by period name; the past ones by key, one per
    // retained period of each non-alltime period.
    const options = within(select)
      .getAllByRole("option")
      .map((o) => (o as HTMLOptionElement).value);
    expect(options[0]).toBe("");
    expect(options).toContain("daily");
    expect(options).toContain(periodKeyAt("daily", Date.now() - 86_400_000));
    await userEvent.selectOptions(select, "daily");
    expect(mockApi.lbScores).toHaveBeenLastCalledWith("lb_1", {
      period: "daily",
      limit: 50,
    });
  });

  it("pages with offset and stops at the end", async () => {
    vi.mocked(mockApi.lbScores).mockResolvedValue({ ...PAGE, total: 120 });
    open();
    await screen.findByText(OWNER_A);
    expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(mockApi.lbScores).toHaveBeenLastCalledWith("lb_1", {
      limit: 50,
      offset: 50,
    });
  });

  it("deletes a score from every period, after a confirm", async () => {
    vi.mocked(mockApi.deleteLbScore).mockResolvedValue({ deleted: 2 });
    open();
    await screen.findByText(OWNER_A);
    await userEvent.click(
      screen.getByRole("button", { name: `Actions for ${OWNER_A}` }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Delete score" }),
    );
    const dialog = await screen.findByRole("dialog");
    // The confirm says what a member cannot see from the table: it is every
    // period, not the one on screen.
    expect(dialog.textContent).toMatch(/every period of this board/);
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Delete score" }),
    );
    expect(mockApi.deleteLbScore).toHaveBeenCalledWith("lb_1", OWNER_A);
  });

  it("clears the addressed bucket, not the board", async () => {
    vi.mocked(mockApi.deleteLbPeriod).mockResolvedValue({
      deleted: 2,
      truncated: false,
    });
    open();
    await screen.findByText(OWNER_A);
    await userEvent.click(screen.getByRole("button", { name: "Clear period" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toMatch(/Other periods keep theirs/);
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Clear period" }),
    );
    // The live bucket is addressed by its period name, which is what the
    // server resolves against its own clock.
    expect(mockApi.deleteLbPeriod).toHaveBeenCalledWith("lb_1", "alltime");
  });

  it("edits only the four editable fields and never a rule", async () => {
    vi.mocked(mockApi.updateLeaderboard).mockResolvedValue({
      ...BOARD,
      name: "ladder",
      maxEntries: 50,
    });
    open();
    await screen.findByText(OWNER_A);
    await userEvent.click(screen.getByRole("button", { name: "Edit" }));
    const drawer = await screen.findByRole("dialog");
    // The immutable four are stated, not offered.
    expect(drawer.textContent).toMatch(/cannot be changed later/);
    // A required Mantine label carries an asterisk, so the queries anchor.
    for (const label of ["Submit", "Rule", "Order"])
      expect(
        within(drawer).queryByLabelText(new RegExp(`^${label}`)),
      ).toBeNull();
    const name = within(drawer).getByLabelText(/^Name/);
    await userEvent.clear(name);
    await userEvent.type(name, "ladder");
    await userEvent.click(within(drawer).getByRole("button", { name: "Save" }));
    expect(mockApi.updateLeaderboard).toHaveBeenCalledWith("lb_1", {
      name: "ladder",
    });
  });

  it("shows a read-only banner and no actions without a seat", async () => {
    vi.mocked(mockApi.team).mockRejectedValue(new Error("nope"));
    open();
    await screen.findByText(OWNER_A);
    expect(await screen.findByText(/read-only/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Clear period" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: `Actions for ${OWNER_A}` }),
    ).toBeNull();
  });

  it("warns when the stage has no state stack", async () => {
    open({ ...BOARD, api: { ...BOARD.api, configured: false } });
    expect(
      await screen.findByText(/no state stack deployed/i),
    ).toBeInTheDocument();
  });
});

describe("period arithmetic in the browser", () => {
  it("keys a daily bucket by the KST civil date", () => {
    // 2026-09-09T15:30Z is 2026-09-10T00:30+09:00.
    expect(periodKeyAt("daily", Date.UTC(2026, 8, 9, 15, 30))).toBe(
      "2026-09-10",
    );
    expect(periodKeyAt("alltime", Date.now())).toBe("");
  });

  it("keys the ISO week the way the server does", () => {
    // The two boundaries: 2026 has 53 ISO weeks, and late December can belong
    // to the next ISO year.
    expect(periodKeyAt("weekly", Date.UTC(2027, 0, 1, 3))).toBe("2026-W53");
    expect(periodKeyAt("weekly", Date.UTC(2024, 11, 30, 3))).toBe("2025-W01");
    expect(periodKeyAt("weekly", Date.UTC(2026, 8, 9, 15, 30))).toBe(
      "2026-W37",
    );
  });

  it("offers the live bucket plus the retained past keys", () => {
    const now = Date.UTC(2026, 8, 9, 15, 30);
    expect(
      bucketOptions(
        { periods: ["alltime", "daily", "weekly"], retainPeriods: 2 },
        now,
      ).map((o) => o.value),
    ).toEqual([
      "alltime",
      "daily",
      "2026-09-09",
      "2026-09-08",
      "weekly",
      "2026-W36",
      "2026-W35",
    ]);
    // `retainPeriods: 0` offers only the live buckets.
    expect(
      bucketOptions({ periods: ["daily"], retainPeriods: 0 }, now).map(
        (o) => o.value,
      ),
    ).toEqual(["daily"]);
  });
});
