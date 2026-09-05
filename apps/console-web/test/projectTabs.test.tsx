import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../src/api";
import type {
  AssetBundle,
  CatalogApp,
  KvCollection,
  ProjectDetail,
  Site,
  TeamDetail,
} from "../src/types";

/*
 * Pins the three list-and-create tabs of the project page (catalog, assets,
 * sites) at the level a user sees: labels, placeholders, limits, columns,
 * links, empty text and the create payload. They are near-copies of one
 * another, so a shared implementation must keep every one of these.
 */

const mockApi = {
  me: vi.fn(),
  logout: vi.fn(),
  loginUrl: vi.fn(() => "/auth/github/start"),
  setUnauthorizedHandler: vi.fn(),
  team: vi.fn(),
  project: vi.fn(),
  projectCatalogApps: vi.fn(),
  createCatalogApp: vi.fn(),
  projectAssetBundles: vi.fn(),
  createAssetBundle: vi.fn(),
  projectSites: vi.fn(),
  createSite: vi.fn(),
  projectKv: vi.fn(),
  createKv: vi.fn(),
} as unknown as ApiClient;

vi.mock("../src/api", () => ({
  api: mockApi,
  ApiError: class extends Error {},
}));

const { ProjectPage } = await import("../src/pages/Project");
const { SITE_SHARED_ORIGIN_WARNING } = await import("../src/pages/Site");
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
    sites: 1,
    kv: 0,
    versions: 0,
    issues: 0,
  },
};
const crumbs = {
  teamId: "team_1",
  teamName: "studio",
  projectId: "prj_1",
  projectName: "game",
};
const APP: CatalogApp = {
  ...crumbs,
  id: "app_1",
  name: "my-game",
  path: "life.yyt.my-game",
  description: null,
  createdBy: "alice",
  createdAt: 0,
  updatedAt: 60,
};
const BUNDLE: AssetBundle = {
  ...crumbs,
  id: "ab_1",
  name: "dungeon-maps",
  description: "tiles",
  createdBy: null,
  createdAt: 0,
  updatedAt: 60,
};
const SITE: Site = {
  ...crumbs,
  id: "site_1",
  name: "game-web",
  slug: "abc",
  description: null,
  publicUrl: "https://g.example/abc/",
  basePath: "/abc/",
  currentDeployId: "dep_1",
  busy: false,
  createdBy: "bob",
  createdAt: 0,
  updatedAt: 60,
};

const KV: KvCollection = {
  ...crumbs,
  createdBy: "alice",
  id: "kv_1",
  name: "profiles",
  readScope: "project",
  writeScope: "user",
  encrypted: false,
  maxEntries: 10000,
  maxEntriesPerOwner: 100,
  entries: 7,
  createdAt: 0,
  updatedAt: 60,
};

function mount(tab: string) {
  return mountWith(
    <Routes>
      <Route path="/teams/:team/projects/:prj/:tab" element={<ProjectPage />} />
    </Routes>,
    { client: mockApi, path: `/teams/team_1/projects/prj_1/${tab}` },
  );
}

/** Opens the tab's `New <noun>` drawer and returns it. */
async function openDrawer(noun: string) {
  await userEvent.click(
    await screen.findByRole("button", { name: `New ${noun}` }),
  );
  return screen.findByRole("dialog");
}

const headers = () =>
  screen.getAllByRole("columnheader").map((h) => h.textContent);
// Mantine appends a required marker to the label, so match its start.
const input = (label: string, scope: HTMLElement) =>
  within(scope).getByLabelText<HTMLInputElement>(new RegExp(`^${label}`));
const limits = (el: HTMLInputElement) => ({
  placeholder: el.placeholder,
  required: el.required,
  maxLength: el.maxLength,
});

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
  vi.mocked(mockApi.projectCatalogApps).mockResolvedValue([APP]);
  vi.mocked(mockApi.projectAssetBundles).mockResolvedValue([BUNDLE]);
  vi.mocked(mockApi.projectSites).mockResolvedValue([SITE]);
  vi.mocked(mockApi.projectKv).mockResolvedValue([KV]);
});

describe("catalog tab", () => {
  it("lists apps with their application id and links to the app", async () => {
    mount("catalog");
    const link = await screen.findByRole("link", { name: "my-game" });
    expect(link).toHaveAttribute("href", "/catalog/apps/app_1");
    expect(headers()).toEqual([
      "App",
      "Application id",
      "Created by",
      "Updated",
    ]);
    const cells = within(link.closest("tr")!)
      .getAllByRole("cell")
      .map((c) => c.textContent);
    expect(cells.slice(1, 3)).toEqual(["life.yyt.my-game", "alice"]);
    const drawer = await openDrawer("app");
    expect(limits(input("Name", drawer))).toEqual({
      placeholder: "name (e.g. my-game)",
      required: true,
      maxLength: 64,
    });
    expect(limits(input("Application id", drawer))).toEqual({
      placeholder: "life.yyt.my-game",
      required: true,
      maxLength: 200,
    });
  });

  it("needs both fields, trims them and reloads after creating", async () => {
    vi.mocked(mockApi.createCatalogApp).mockResolvedValue({
      ...APP,
      id: "app_2",
      name: "next",
    });
    mount("catalog");
    const drawer = await openDrawer("app");
    const button = within(drawer).getByRole("button", { name: "Create app" });
    expect(button).toBeDisabled();
    await userEvent.type(input("Name", drawer), " next ");
    expect(button).toBeDisabled();
    await userEvent.type(input("Application id", drawer), "life.yyt.next ");
    expect(button).toBeEnabled();
    await userEvent.click(button);
    expect(mockApi.createCatalogApp).toHaveBeenCalledWith("prj_1", {
      name: "next",
      path: "life.yyt.next",
    });
    await waitFor(() =>
      expect(mockApi.projectCatalogApps).toHaveBeenCalledTimes(2),
    );
    // The drawer closes on success and comes back empty.
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const again = await openDrawer("app");
    expect(input("Name", again).value).toBe("");
    expect(input("Application id", again).value).toBe("");
  });

  it("says when there is nothing yet", async () => {
    vi.mocked(mockApi.projectCatalogApps).mockResolvedValue([]);
    mount("catalog");
    expect(await screen.findByText("No apps yet.")).toBeInTheDocument();
  });
});

describe("assets tab", () => {
  it("lists bundles and sends the description only when given", async () => {
    vi.mocked(mockApi.createAssetBundle).mockResolvedValue({
      ...BUNDLE,
      id: "ab_2",
    });
    mount("assets");
    const link = await screen.findByRole("link", { name: "dungeon-maps" });
    expect(link).toHaveAttribute("href", "/assets/ab_1");
    expect(headers()).toEqual([
      "Bundle",
      "Description",
      "Created by",
      "Updated",
    ]);
    const cells = within(link.closest("tr")!)
      .getAllByRole("cell")
      .map((c) => c.textContent);
    expect(cells.slice(1, 3)).toEqual(["tiles", "—"]);
    let drawer = await openDrawer("bundle");
    expect(limits(input("Name", drawer))).toEqual({
      placeholder: "name (e.g. dungeon-maps)",
      required: true,
      maxLength: 64,
    });
    expect(limits(input("Description", drawer))).toEqual({
      placeholder: "optional",
      required: false,
      maxLength: 2000,
    });
    let button = within(drawer).getByRole("button", { name: "Create bundle" });
    expect(button).toBeDisabled();
    await userEvent.type(input("Name", drawer), "sounds");
    await userEvent.type(input("Description", drawer), "   ");
    await userEvent.click(button);
    expect(mockApi.createAssetBundle).toHaveBeenCalledWith("prj_1", {
      name: "sounds",
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    drawer = await openDrawer("bundle");
    button = within(drawer).getByRole("button", { name: "Create bundle" });
    await userEvent.type(input("Name", drawer), "more");
    await userEvent.type(input("Description", drawer), " sfx ");
    await userEvent.click(button);
    expect(mockApi.createAssetBundle).toHaveBeenLastCalledWith("prj_1", {
      name: "more",
      description: "sfx",
    });
  });

  it("says when there is nothing yet", async () => {
    vi.mocked(mockApi.projectAssetBundles).mockResolvedValue([]);
    mount("assets");
    expect(
      await screen.findByText("No asset bundles yet."),
    ).toBeInTheDocument();
  });
});

describe("sites tab", () => {
  it("warns about the shared origin and shows the live state per site", async () => {
    vi.mocked(mockApi.projectSites).mockResolvedValue([
      SITE,
      { ...SITE, id: "site_2", name: "draft", currentDeployId: null },
      { ...SITE, id: "site_3", name: "rolling", busy: true },
    ]);
    mount("sites");
    const link = await screen.findByRole("link", { name: "game-web" });
    expect(link).toHaveAttribute("href", "/sites/site_1");
    expect(headers()).toEqual(["Site", "URL", "Live", "Updated"]);
    const external = screen.getAllByRole("link", {
      name: "https://g.example/abc/",
    })[0]!;
    expect(external).toHaveAttribute("target", "_blank");
    expect(external).toHaveAttribute("rel", "noopener noreferrer");
    const live = (name: string) =>
      within(screen.getByRole("link", { name }).closest("tr")!).getAllByRole(
        "cell",
      )[2]!.textContent;
    expect(live("game-web")).toBe("live");
    expect(live("draft")).toBe("empty");
    expect(live("rolling")).toBe("deploying");
    expect(screen.getByText(SITE_SHARED_ORIGIN_WARNING)).toBeInTheDocument();
    const drawer = await openDrawer("site");
    expect(limits(input("Name", drawer))).toEqual({
      placeholder: "name (e.g. game-web)",
      required: true,
      maxLength: 64,
    });
    expect(
      within(drawer).getByRole("button", { name: "Create site" }),
    ).toBeDisabled();
  });

  it("says when there is nothing yet", async () => {
    vi.mocked(mockApi.projectSites).mockResolvedValue([]);
    mount("sites");
    expect(await screen.findByText("No sites yet.")).toBeInTheDocument();
  });
});

describe("kv tab", () => {
  it("lists collections with their scopes and links to the collection", async () => {
    vi.mocked(mockApi.projectKv).mockResolvedValue([
      KV,
      { ...KV, id: "kv_2", name: "secrets", encrypted: true, entries: 0 },
    ]);
    mount("kv");
    const link = await screen.findByRole("link", { name: "profiles" });
    expect(link).toHaveAttribute("href", "/kv/kv_1");
    expect(headers()).toEqual([
      "Name",
      "Read",
      "Write",
      "Encrypted",
      "Entries",
      "Updated",
    ]);
    expect(
      within(link.closest("tr")!)
        .getAllByRole("cell")
        .map((c) => c.textContent)
        .slice(1, 5),
    ).toEqual(["project", "user", "—", "7"]);
    expect(
      within(screen.getByRole("link", { name: "secrets" }).closest("tr")!)
        .getAllByRole("cell")
        .map((c) => c.textContent)[3],
    ).toBe("yes");
    expect(mockApi.projectKv).toHaveBeenCalledWith("prj_1", {});
  });

  it("creates with the chosen scopes, omits the defaults and refuses a bad shape", async () => {
    const { entries: _count, ...kvWritten } = KV;
    vi.mocked(mockApi.createKv).mockResolvedValue({
      ...kvWritten,
      id: "kv_3",
      description: null,
      api: {
        configured: true,
        baseUrl: "https://doc.example",
        metaPath: "/kv/kv_3",
        entriesPath: "/kv/kv_3/entries",
      },
    });
    mount("kv");
    const drawer = await openDrawer("collection");
    const button = within(drawer).getByRole("button", {
      name: "Create collection",
    });
    expect(button).toBeDisabled();
    await userEvent.type(input("Name", drawer), " progress ");
    expect(button).toBeEnabled();
    const read = within(drawer).getByLabelText(/^Read scope/);
    const write = within(drawer).getByLabelText(/^Write scope/);
    // user read without user write: refused before the request.
    await userEvent.selectOptions(read, "user");
    expect(
      within(drawer).getByText(/A user read scope needs a user write scope/),
    ).toBeInTheDocument();
    expect(button).toBeDisabled();
    await userEvent.selectOptions(read, "project");
    await userEvent.selectOptions(write, "user");
    expect(
      within(drawer).getByText(
        "project-read + user-write lets every player list every owner's entries.",
      ),
    ).toBeInTheDocument();
    // encrypted with a team scope: refused too.
    await userEvent.selectOptions(read, "team");
    await userEvent.click(within(drawer).getByLabelText(/^Encrypted/));
    expect(
      within(drawer).getByText(/An encrypted collection needs project or user/),
    ).toBeInTheDocument();
    expect(button).toBeDisabled();
    await userEvent.selectOptions(read, "project");
    expect(button).toBeEnabled();
    const perOwner = input("Max entries per owner", drawer);
    await userEvent.clear(perOwner);
    await userEvent.type(perOwner, "5");
    await userEvent.click(button);
    expect(mockApi.createKv).toHaveBeenCalledWith("prj_1", {
      name: "progress",
      readScope: "project",
      writeScope: "user",
      encrypted: true,
      maxEntriesPerOwner: 5,
    });
    await waitFor(() => expect(mockApi.projectKv).toHaveBeenCalledTimes(2));
    // The header counts come from the project row.
    await waitFor(() => expect(mockApi.project).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("says when there is nothing yet", async () => {
    vi.mocked(mockApi.projectKv).mockResolvedValue([]);
    mount("kv");
    expect(
      await screen.findByText("No kv collections yet."),
    ).toBeInTheDocument();
  });
});

describe("read-only standing", () => {
  it("hides every create form from a seatless admin", async () => {
    vi.mocked(mockApi.team).mockResolvedValue({ ...TEAM, role: "admin" });
    for (const [tab, label] of [
      ["catalog", "New app"],
      ["assets", "New bundle"],
      ["sites", "New site"],
      ["kv", "New collection"],
    ] as const) {
      const r = mount(tab);
      await screen.findByRole("table");
      expect(screen.queryByRole("button", { name: label })).toBeNull();
      r.unmount();
    }
  });
});
