import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../src/api";
import type {
  IssueDetail,
  ProjectDetail,
  TeamDetail,
  Version,
} from "../src/types";

const mockApi = {
  me: vi.fn(),
  logout: vi.fn(),
  loginUrl: vi.fn(() => "/auth/github/start"),
  setUnauthorizedHandler: vi.fn(),
  team: vi.fn(),
  project: vi.fn(),
  versions: vi.fn(),
  version: vi.fn(),
  bumpVersion: vi.fn(),
  issues: vi.fn(),
  issue: vi.fn(),
  createIssue: vi.fn(),
  setIssueStatus: vi.fn(),
  projectChannels: vi.fn(),
  projectCatalogApps: vi.fn(),
  projectAssetBundles: vi.fn(),
} as unknown as ApiClient;

vi.mock("../src/api", () => ({
  api: mockApi,
  ApiError: class extends Error {},
}));

const { ProjectPage } = await import("../src/pages/Project");
const { IssuePage } = await import("../src/pages/Issue");
const { mount: mountWith } = await import("./wrap");

const TEAM: TeamDetail = { id: "team_1", name: "studio", role: "member" };
const PROJECT: ProjectDetail = {
  id: "prj_1",
  teamId: "team_1",
  teamName: "studio",
  name: "game",
  description: null,
  createdBy: "alice",
  createdAt: 0,
  updatedAt: 0,
  counts: {
    channels: 0,
    apps: 0,
    bundles: 0,
    sites: 0,
    versions: 1,
    issues: 1,
  },
};
const V1: Version = {
  id: "ver_1",
  projectId: "prj_1",
  name: "v1.2.3",
  note: null,
  createdBy: "alice",
  createdAt: 0,
  artifactCount: 2,
  assetCount: 3,
};
const ISSUE: IssueDetail = {
  id: "iss_1",
  projectId: "prj_1",
  number: 1,
  title: "Crash on start",
  bodyMd: "See <script>alert(1)</script> [repro](https://x.test/r)",
  status: "open",
  versionId: "ver_1",
  createdBy: "bob",
  createdAt: 0,
  updatedAt: 0,
  closedAt: null,
  comments: [],
};

function mount(path: string) {
  return mountWith(
    <Routes>
      <Route path="/teams/:team/projects/:prj/:tab" element={<ProjectPage />} />
      <Route
        path="/teams/:team/projects/:prj/issues/:n"
        element={<IssuePage />}
      />
    </Routes>,
    { client: mockApi, path },
  );
}

describe("ProjectPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(mockApi.me).mockResolvedValue({
      id: "m_1",
      login: "alice",
      role: "member",
      via: "session",
    });
    vi.mocked(mockApi.team).mockResolvedValue(TEAM);
    vi.mocked(mockApi.project).mockResolvedValue(PROJECT);
    vi.mocked(mockApi.versions).mockResolvedValue([V1]);
    vi.mocked(mockApi.issues).mockResolvedValue([ISSUE]);
    vi.mocked(mockApi.issue).mockResolvedValue(ISSUE);
  });

  it("bumps a version and reloads the list", async () => {
    vi.mocked(mockApi.bumpVersion).mockResolvedValue({
      ...V1,
      id: "ver_2",
      name: "v1.2.4",
    });
    vi.mocked(mockApi.versions)
      .mockResolvedValueOnce([V1])
      .mockResolvedValue([{ ...V1, id: "ver_2", name: "v1.2.4" }, V1]);
    mount("/teams/team_1/projects/prj_1/versions");
    // The help text also says "v1.2.3"; wait for the row itself.
    await screen.findByRole("link", { name: "v1.2.3" });
    // Live link counts sit in the list, no popup needed.
    const row = screen.getByRole("link", { name: "v1.2.3" }).closest("tr")!;
    const cells = within(row)
      .getAllByRole("cell")
      .map((c) => c.textContent);
    expect(screen.getByText("Artifacts")).toBeInTheDocument();
    expect(cells.slice(2, 4)).toEqual(["2", "3"]);
    await userEvent.click(screen.getByRole("button", { name: "Bump patch" }));
    expect(mockApi.bumpVersion).toHaveBeenCalledWith("prj_1", "patch");
    expect(await screen.findByText("v1.2.4")).toBeInTheDocument();
  });

  it("links a version row to its page", async () => {
    mount("/teams/team_1/projects/prj_1/versions");
    expect(
      (await screen.findByRole("link", { name: "v1.2.3" })).getAttribute(
        "href",
      ),
    ).toBe("/teams/team_1/projects/prj_1/versions/ver_1");
    expect(mockApi.version).not.toHaveBeenCalled();
  });

  it("lists issues with their version and hides creation from a seatless admin", async () => {
    vi.mocked(mockApi.team).mockResolvedValue({ ...TEAM, role: "admin" });
    mount("/teams/team_1/projects/prj_1/issues");
    expect(
      await screen.findByRole("link", { name: "Crash on start" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "v1.2.3" }).getAttribute("href"),
    ).toBe("/teams/team_1/projects/prj_1/versions/ver_1");
    expect(screen.queryByRole("button", { name: "New issue" })).toBeNull();
    expect(screen.getByText("read-only")).toBeInTheDocument();
  });
});

describe("IssuePage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(mockApi.me).mockResolvedValue({
      id: "m_1",
      login: "alice",
      role: "member",
      via: "session",
    });
    vi.mocked(mockApi.team).mockResolvedValue(TEAM);
    vi.mocked(mockApi.project).mockResolvedValue(PROJECT);
    vi.mocked(mockApi.versions).mockResolvedValue([V1]);
    vi.mocked(mockApi.issue).mockResolvedValue(ISSUE);
  });

  it("renders the body sanitized and closes the issue", async () => {
    vi.mocked(mockApi.setIssueStatus).mockResolvedValue({
      ...ISSUE,
      status: "closed",
      closedAt: 10,
    });
    const { container } = mount("/teams/team_1/projects/prj_1/issues/1");
    await screen.findByText("#1 Crash on start");
    expect(container.querySelector("script")).toBeNull();
    expect(
      screen.getByRole("link", { name: "repro" }).getAttribute("rel"),
    ).toContain("noopener");
    await userEvent.click(
      await screen.findByRole("button", { name: "More actions" }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Close issue" }),
    );
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Close issue" }),
    );
    expect(mockApi.setIssueStatus).toHaveBeenCalledWith("prj_1", 1, "close");
    expect(await screen.findByText("closed")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "More actions" }));
    expect(
      await screen.findByRole("menuitem", { name: "Reopen issue" }),
    ).toBeInTheDocument();
  });
});
