import { MantineProvider } from "@mantine/core";
import { ModalsProvider } from "@mantine/modals";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
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
const { theme } = await import("../src/theme");
const { AuthProvider } = await import("../src/auth");

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
                <Route
                  path="/teams/:team/projects/:prj/:tab"
                  element={<ProjectPage />}
                />
                <Route
                  path="/teams/:team/projects/:prj/issues/:n"
                  element={<IssuePage />}
                />
              </Routes>
            </ModalsProvider>
          </AuthProvider>
        </MemoryRouter>
      </QueryClientProvider>
    </MantineProvider>,
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
    await screen.findByRole("button", { name: "v1.2.3" });
    // Live link counts sit in the list, no popup needed.
    const row = screen.getByRole("button", { name: "v1.2.3" }).closest("tr")!;
    const cells = within(row)
      .getAllByRole("cell")
      .map((c) => c.textContent);
    expect(screen.getByText("Artifacts")).toBeInTheDocument();
    expect(cells.slice(2, 4)).toEqual(["2", "3"]);
    await userEvent.click(screen.getByRole("button", { name: "Bump patch" }));
    expect(mockApi.bumpVersion).toHaveBeenCalledWith("prj_1", "patch");
    expect(await screen.findByText("v1.2.4")).toBeInTheDocument();
  });

  it("opens the version modal with its links", async () => {
    vi.mocked(mockApi.version).mockResolvedValue({
      ...V1,
      links: [
        {
          id: "lnk_1",
          versionId: "ver_1",
          kind: "asset_version",
          artifactId: null,
          bundleId: "ab_1",
          assetVersion: "v1",
          createdAt: 0,
        },
      ],
    });
    vi.mocked(mockApi.projectCatalogApps).mockResolvedValue([]);
    vi.mocked(mockApi.projectAssetBundles).mockResolvedValue([]);
    mount("/teams/team_1/projects/prj_1/versions");
    await userEvent.click(
      await screen.findByRole("button", { name: "v1.2.3" }),
    );
    expect(await screen.findByText("asset ab_1 @ v1")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add link" })).toBeDisabled();
  });

  it("lists issues with their version and hides creation from a seatless admin", async () => {
    vi.mocked(mockApi.team).mockResolvedValue({ ...TEAM, role: "admin" });
    mount("/teams/team_1/projects/prj_1/issues");
    expect(
      await screen.findByRole("link", { name: "Crash on start" }),
    ).toBeInTheDocument();
    expect(screen.getByText("v1.2.3")).toBeInTheDocument();
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
    await userEvent.click(screen.getByRole("button", { name: "Close issue" }));
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(mockApi.setIssueStatus).toHaveBeenCalledWith("prj_1", 1, "close");
    expect(await screen.findByText("closed")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Reopen issue" }),
    ).toBeInTheDocument();
  });
});
