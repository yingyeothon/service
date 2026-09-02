import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../src/api";
import type {
  Issue,
  ProjectDetail,
  TeamDetail,
  VersionDetail,
} from "../src/types";

const mockApi = {
  me: vi.fn(),
  logout: vi.fn(),
  loginUrl: vi.fn(() => "/auth/github/start"),
  setUnauthorizedHandler: vi.fn(),
  team: vi.fn(),
  project: vi.fn(),
  version: vi.fn(),
  updateVersion: vi.fn(),
  deleteVersion: vi.fn(),
  addVersionLink: vi.fn(),
  removeVersionLink: vi.fn(),
  issues: vi.fn(),
  projectCatalogApps: vi.fn(),
  projectAssetBundles: vi.fn(),
  catalogArtifacts: vi.fn(),
  assetBundle: vi.fn(),
} as unknown as ApiClient;

vi.mock("../src/api", () => ({
  api: mockApi,
  ApiError: class extends Error {},
}));

const { VersionPage } = await import("../src/pages/Version");
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
    apps: 1,
    bundles: 1,
    sites: 0,
    versions: 1,
    issues: 1,
  },
};
const VERSION: VersionDetail = {
  id: "ver_1",
  projectId: "prj_1",
  name: "1.2.3",
  note: "Fixes the **crash**",
  createdBy: "alice",
  createdAt: 0,
  artifactCount: 2,
  assetCount: 1,
  links: [
    {
      id: "lnk_1",
      versionId: "ver_1",
      kind: "artifact",
      artifactId: "art_1",
      bundleId: null,
      assetVersion: null,
      createdAt: 0,
      artifact: {
        appId: "ca_1",
        appName: "myapp",
        platform: "android",
        version: "1.2.3+45",
        abi: "arm64-v8a",
        buildType: "release",
        url: "https://dev-d.yyt.life/apps/ca_1/u1/app.apk",
        createdAt: 0,
      },
      bundleName: null,
    },
    {
      id: "lnk_4",
      versionId: "ver_1",
      kind: "artifact",
      artifactId: "art_2",
      bundleId: null,
      assetVersion: null,
      createdAt: 0,
      artifact: {
        appId: "ca_1",
        appName: "myapp",
        platform: "android",
        version: "1.2.3+45",
        abi: "x86_64",
        buildType: "release",
        url: "https://dev-d.yyt.life/apps/ca_1/u2/app.apk",
        createdAt: 0,
      },
      bundleName: null,
    },
    {
      id: "lnk_2",
      versionId: "ver_1",
      kind: "artifact",
      artifactId: "art_gone",
      bundleId: null,
      assetVersion: null,
      createdAt: 0,
      artifact: null,
      bundleName: null,
    },
    {
      id: "lnk_3",
      versionId: "ver_1",
      kind: "asset_version",
      artifactId: null,
      bundleId: "ab_1",
      assetVersion: "v7",
      createdAt: 0,
      artifact: null,
      bundleName: "maps",
    },
  ],
};
const ISSUE: Issue = {
  id: "iss_1",
  projectId: "prj_1",
  number: 4,
  title: "Crash on start",
  status: "open",
  versionId: "ver_1",
  createdBy: "bob",
  createdAt: 0,
  updatedAt: 0,
  closedAt: null,
};

function mount(path = "/teams/team_1/projects/prj_1/versions/ver_1") {
  return mountWith(
    <Routes>
      <Route
        path="/teams/:team/projects/:prj/versions/:ver"
        element={<VersionPage />}
      />
      <Route
        path="/teams/:team/projects/:prj/:tab"
        element={<h1>project tab</h1>}
      />
    </Routes>,
    { client: mockApi, path },
  );
}

describe("VersionPage", () => {
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
    vi.mocked(mockApi.version).mockResolvedValue(VERSION);
    vi.mocked(mockApi.issues).mockResolvedValue([ISSUE]);
    vi.mocked(mockApi.projectCatalogApps).mockResolvedValue([]);
    vi.mocked(mockApi.projectAssetBundles).mockResolvedValue([]);
  });

  it("names its links and lists the issues the server filtered by version", async () => {
    mount();
    expect(
      await screen.findByRole("heading", { level: 1, name: "1.2.3" }),
    ).toBeInTheDocument();
    expect(screen.getByText("crash")).toBeInTheDocument(); // the note, rendered
    // An artifact link names its app, version and build and goes to the app
    // page; two ABIs of one deploy are two distinguishable rows.
    expect(
      screen
        .getByRole("link", { name: "myapp 1.2.3+45 arm64-v8a release" })
        .getAttribute("href"),
    ).toBe("/catalog/apps/ca_1");
    expect(
      screen.getByRole("link", { name: "myapp 1.2.3+45 x86_64 release" }),
    ).toBeInTheDocument();
    expect(screen.getAllByText("android")).toHaveLength(2);
    // A vanished target falls back to its id; an asset link names its bundle.
    expect(screen.getByText("artifact art_gone")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "maps @ v7" }).getAttribute("href"),
    ).toBe("/assets/ab_1");
    // Issues come from the server filtered by this version — never in the page.
    expect(mockApi.issues).toHaveBeenCalledWith("prj_1", undefined, {
      versionId: "ver_1",
    });
    expect(
      (
        await screen.findByRole("link", { name: "Crash on start" })
      ).getAttribute("href"),
    ).toBe("/teams/team_1/projects/prj_1/issues/4");
    // The Version column is pointless here; sorting asks the server.
    expect(screen.queryByRole("button", { name: "Version" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Updated" }));
    expect(mockApi.issues).toHaveBeenLastCalledWith("prj_1", undefined, {
      sort: "updatedAt",
      order: "desc",
      versionId: "ver_1",
    });
  });

  it("edits the note in a drawer and deletes from its danger zone", async () => {
    vi.mocked(mockApi.updateVersion).mockResolvedValue({
      ...VERSION,
      note: "Now *better*",
    });
    vi.mocked(mockApi.deleteVersion).mockResolvedValue(undefined);
    mount();
    await screen.findByRole("heading", { level: 1, name: "1.2.3" });
    await userEvent.click(screen.getByRole("button", { name: "Edit" }));
    const drawer = await screen.findByRole("dialog");
    const note = within(drawer).getByLabelText("Release note");
    await userEvent.clear(note);
    await userEvent.type(note, "Now *better*");
    await userEvent.click(within(drawer).getByRole("button", { name: "Save" }));
    expect(mockApi.updateVersion).toHaveBeenCalledWith(
      "prj_1",
      "ver_1",
      "Now *better*",
    );
    expect(await screen.findByText("better")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Edit" }));
    const again = await screen.findByRole("dialog");
    await userEvent.click(
      within(again).getByRole("button", { name: "Delete version" }),
    );
    const modal = (await screen.findByText("Delete 1.2.3?")).closest(
      '[role="dialog"]',
    ) as HTMLElement;
    await userEvent.click(
      within(modal).getByRole("button", { name: "Delete version" }),
    );
    await waitFor(() =>
      expect(mockApi.deleteVersion).toHaveBeenCalledWith("prj_1", "ver_1"),
    );
    expect(await screen.findByText("project tab")).toBeInTheDocument();
  });

  it("adds and removes links", async () => {
    vi.mocked(mockApi.projectCatalogApps).mockResolvedValue([
      { id: "ca_1", name: "myapp" } as never,
    ]);
    vi.mocked(mockApi.catalogArtifacts).mockResolvedValue([
      {
        id: "art_9",
        platform: "android",
        tags: { version: "9.0.0" },
        createdAt: 0,
      } as never,
    ]);
    vi.mocked(mockApi.addVersionLink).mockResolvedValue(VERSION.links[0]!);
    vi.mocked(mockApi.removeVersionLink).mockResolvedValue(undefined);
    mount();
    await screen.findByRole("heading", { level: 1, name: "1.2.3" });
    await userEvent.click(screen.getByRole("button", { name: "Add link" }));
    const drawer = await screen.findByRole("dialog");
    expect(
      within(drawer).getByRole("button", { name: "Add link" }),
    ).toBeDisabled();
    await userEvent.selectOptions(within(drawer).getByLabelText("App"), "ca_1");
    await userEvent.selectOptions(
      within(drawer).getByLabelText("Artifact"),
      "art_9",
    );
    await userEvent.click(
      within(drawer).getByRole("button", { name: "Add link" }),
    );
    expect(mockApi.addVersionLink).toHaveBeenCalledWith("prj_1", "ver_1", {
      kind: "artifact",
      artifactId: "art_9",
    });
    expect(mockApi.version).toHaveBeenCalledTimes(2);

    await userEvent.click(
      screen.getByRole("button", { name: "Actions for maps @ v7" }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Unlink" }),
    );
    const modal = (await screen.findByText("Unlink?")).closest(
      '[role="dialog"]',
    ) as HTMLElement;
    await userEvent.click(
      within(modal).getByRole("button", { name: "Unlink" }),
    );
    await waitFor(() =>
      expect(mockApi.removeVersionLink).toHaveBeenCalledWith(
        "prj_1",
        "ver_1",
        "lnk_3",
      ),
    );
  });

  it("is read-only for a seatless admin", async () => {
    vi.mocked(mockApi.me).mockResolvedValue({
      id: "m_9",
      login: "boss",
      role: "admin",
      via: "session",
    });
    vi.mocked(mockApi.team).mockResolvedValue({ ...TEAM, role: "admin" });
    mount();
    await screen.findByRole("heading", { level: 1, name: "1.2.3" });
    expect(await screen.findByText(/Read-only/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add link" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Actions for/ })).toBeNull();
  });
});
