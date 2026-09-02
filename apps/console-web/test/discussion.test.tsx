import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../src/api";
import type { DiscussionDetail, TeamDetail } from "../src/types";

const mockApi = {
  me: vi.fn(),
  logout: vi.fn(),
  loginUrl: vi.fn(() => "/auth/github/start"),
  setUnauthorizedHandler: vi.fn(),
  team: vi.fn(),
  discussion: vi.fn(),
  updateDiscussion: vi.fn(),
  deleteDiscussion: vi.fn(),
  addDiscussionComment: vi.fn(),
} as unknown as ApiClient;

vi.mock("../src/api", () => ({
  api: mockApi,
  ApiError: class extends Error {},
}));

const { DiscussionPage } = await import("../src/pages/Discussion");
const { mount } = await import("./wrap");

const TEAM: TeamDetail = { id: "team_1", name: "studio", role: "member" };
const DISC: DiscussionDetail = {
  id: "d_1",
  teamId: "team_1",
  title: "Jam date",
  bodyMd: "How about **May**?",
  createdBy: "alice",
  createdAt: 0,
  updatedAt: 0,
  mine: true,
  comments: [
    {
      id: "c1",
      bodyMd: "fine",
      createdBy: "bob",
      createdAt: 0,
      updatedAt: 0,
      mine: false,
    },
  ],
};

function open(disc = DISC) {
  vi.mocked(mockApi.discussion).mockResolvedValue(disc);
  return mount(
    <Routes>
      <Route path="/teams/:team/discussions/:id" element={<DiscussionPage />} />
      <Route path="/teams/:team/:tab" element={<p>team tab</p>} />
    </Routes>,
    { client: mockApi, path: "/teams/team_1/discussions/d_1" },
  );
}

describe("DiscussionPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(mockApi.me).mockResolvedValue({
      id: "u1",
      login: "alice",
      role: "member",
      via: "session",
    });
    vi.mocked(mockApi.team).mockResolvedValue(TEAM);
  });

  it("renders the title, the markdown body and the comments", async () => {
    open();
    expect(
      await screen.findByRole("heading", { name: "Jam date" }),
    ).toBeInTheDocument();
    expect(screen.getByText("May", { selector: "strong" })).toBeInTheDocument();
    expect(screen.getByText("fine")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "studio" })).toHaveAttribute(
      "href",
      "/teams/team_1",
    );
  });

  it("edits the body and saves the trimmed title", async () => {
    vi.mocked(mockApi.updateDiscussion).mockResolvedValue({
      ...DISC,
      title: "Jam date?",
    });
    open();
    await screen.findByRole("heading", { name: "Jam date" });
    await userEvent.click(await screen.findByRole("button", { name: "Edit" }));
    const drawer = await screen.findByRole("dialog");
    const title = within(drawer).getByLabelText(/Title/);
    await userEvent.clear(title);
    await userEvent.type(title, " Jam date? ");
    await userEvent.click(within(drawer).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(mockApi.updateDiscussion).toHaveBeenCalledWith("team_1", "d_1", {
        title: "Jam date?",
        bodyMd: "How about **May**?",
      }),
    );
    expect(
      await screen.findByRole("heading", { name: "Jam date?" }),
    ).toBeInTheDocument();
  });

  it("deletes after confirmation and returns to the team's discussions", async () => {
    vi.mocked(mockApi.deleteDiscussion).mockResolvedValue(undefined);
    open();
    await screen.findByRole("heading", { name: "Jam date" });
    // The author's delete is the danger zone of the edit drawer.
    await userEvent.click(await screen.findByRole("button", { name: "Edit" }));
    const drawer = await screen.findByRole("dialog");
    await userEvent.click(
      within(drawer).getByRole("button", { name: "Delete discussion" }),
    );
    const modal = (await screen.findByText("Delete discussion?")).closest(
      '[role="dialog"]',
    ) as HTMLElement;
    await userEvent.click(
      within(modal).getByRole("button", { name: "Delete discussion" }),
    );
    await waitFor(() =>
      expect(mockApi.deleteDiscussion).toHaveBeenCalledWith("team_1", "d_1"),
    );
    expect(await screen.findByText("team tab")).toBeInTheDocument();
  });

  it("offers neither edit nor delete on someone else's discussion to a plain member", async () => {
    open({ ...DISC, mine: false });
    await screen.findByRole("heading", { name: "Jam date" });
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.queryByRole("button", { name: "More actions" })).toBeNull();
  });
});

describe("DiscussionPage as a non-author owner", () => {
  it("offers delete in the header menu without an edit", async () => {
    vi.clearAllMocks();
    vi.mocked(mockApi.me).mockResolvedValue({
      id: "u1",
      login: "alice",
      role: "member",
      via: "session",
    });
    vi.mocked(mockApi.team).mockResolvedValue({ ...TEAM, role: "owner" });
    vi.mocked(mockApi.deleteDiscussion).mockResolvedValue(undefined);
    open({ ...DISC, mine: false });
    await screen.findByRole("heading", { name: "Jam date" });
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    await userEvent.click(
      await screen.findByRole("button", { name: "More actions" }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Delete discussion" }),
    );
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Delete discussion" }),
    );
    await waitFor(() =>
      expect(mockApi.deleteDiscussion).toHaveBeenCalledWith("team_1", "d_1"),
    );
  });
});
