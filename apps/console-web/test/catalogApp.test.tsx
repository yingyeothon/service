import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../src/api";
import type { CatalogApp, CatalogArtifact, TeamDetail } from "../src/types";

const mockApi = {
  me: vi.fn(),
  logout: vi.fn(),
  loginUrl: vi.fn(() => "/auth/github/start"),
  setUnauthorizedHandler: vi.fn(),
  team: vi.fn(),
  catalogApp: vi.fn(),
  catalogArtifacts: vi.fn(),
  catalogSettings: vi.fn(),
  updateCatalogSettings: vi.fn(),
  updateCatalogApp: vi.fn(),
  deleteCatalogApp: vi.fn(),
  deleteCatalogArtifact: vi.fn(),
  cleanupCatalogArtifacts: vi.fn(),
  uploadCatalogArtifact: vi.fn(),
} as unknown as ApiClient;

vi.mock("../src/api", () => ({
  api: mockApi,
  ApiError: class extends Error {},
}));

const { CatalogAppPage } = await import("../src/pages/CatalogApp");
const { mount } = await import("./wrap");

const TEAM: TeamDetail = { id: "team_1", name: "studio", role: "member" };
const APP: CatalogApp = {
  id: "ca_1",
  name: "my-game",
  path: "life.yyt.my-game",
  description: null,
  createdAt: 0,
  updatedAt: 0,
  teamId: "team_1",
  teamName: "studio",
  projectId: "prj_1",
  projectName: "dungeon",
  createdBy: "alice",
};
const ARTIFACTS: CatalogArtifact[] = [
  {
    id: "art_1",
    appId: "ca_1",
    platform: "android",
    url: "https://cdn.example/a.apk",
    objectKey: "apps/ca_1/1.0.0/a.apk",
    size: 1024,
    hash: null,
    tags: {
      version: "1.0.0",
      build_type: "release",
      commit: "abc1234",
      changelog: "first release",
    },
    createdAt: 0,
  },
];

function open() {
  vi.mocked(mockApi.catalogApp).mockResolvedValue(APP);
  vi.mocked(mockApi.catalogArtifacts).mockResolvedValue(ARTIFACTS);
  return mount(
    <Routes>
      <Route path="/catalog/apps/:id" element={<CatalogAppPage />} />
      <Route
        path="/teams/:team/projects/:prj/:tab"
        element={<p>project tab</p>}
      />
    </Routes>,
    { client: mockApi, path: "/catalog/apps/ca_1" },
  );
}

describe("CatalogAppPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(mockApi.me).mockResolvedValue({
      id: "u1",
      login: "alice",
      role: "member",
      via: "session",
    });
    vi.mocked(mockApi.team).mockResolvedValue(TEAM);
    vi.mocked(mockApi.catalogSettings).mockResolvedValue({
      slackHookUrl: null,
      slackChannel: null,
      messageTemplate: null,
      keepRecentVersions: 5,
    });
  });

  it("shows the app, its artifacts grouped by version and the settings in the drawer", async () => {
    open();
    expect(
      await screen.findByRole("heading", { name: "my-game" }),
    ).toBeInTheDocument();
    expect(screen.getByText("ca_1")).toBeInTheDocument();
    expect(await screen.findByText("1.0.0")).toBeInTheDocument();
    for (const c of [
      "Version",
      "Platform",
      "File",
      "Size",
      "Created",
      "Changelog",
    ])
      expect(screen.getByRole("columnheader", { name: c })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "a.apk" })).toHaveAttribute(
      "href",
      "https://cdn.example/a.apk",
    );
    const editBtn = await screen.findByRole("button", { name: "Edit" });
    // Edit waits for the settings: the drawer seeds its fields from them.
    await waitFor(() => expect(editBtn).toBeEnabled());
    await userEvent.click(editBtn);
    const drawer = await screen.findByRole("dialog");
    expect(
      await within(drawer).findByLabelText("Slack webhook URL"),
    ).toBeInTheDocument();
    expect(within(drawer).getByLabelText("Keep recent versions")).toHaveValue(
      "5",
    );
  });

  it("saves only the changed info fields, and only the changed settings", async () => {
    vi.mocked(mockApi.updateCatalogApp).mockResolvedValue({
      ...APP,
      path: "life.yyt.game",
    });
    vi.mocked(mockApi.updateCatalogSettings).mockResolvedValue({
      slackHookUrl: null,
      slackChannel: "#releases",
      messageTemplate: null,
      keepRecentVersions: 5,
    });
    open();
    await userEvent.click(await screen.findByRole("button", { name: "Edit" }));
    let drawer = await screen.findByRole("dialog");
    const path = within(drawer).getByLabelText(/^Application id/);
    await userEvent.clear(path);
    await userEvent.type(path, "life.yyt.game");
    await userEvent.click(within(drawer).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(mockApi.updateCatalogApp).toHaveBeenCalledWith("ca_1", {
        path: "life.yyt.game",
      }),
    );
    expect(mockApi.updateCatalogSettings).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await userEvent.click(await screen.findByRole("button", { name: "Edit" }));
    drawer = await screen.findByRole("dialog");
    await userEvent.type(
      await within(drawer).findByLabelText("Slack channel"),
      "#releases",
    );
    await userEvent.click(within(drawer).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(mockApi.updateCatalogSettings).toHaveBeenCalledWith("ca_1", {
        slackChannel: "#releases",
      }),
    );
    expect(mockApi.updateCatalogApp).toHaveBeenCalledTimes(1);
  });

  it("deletes an artifact from its row menu after confirmation", async () => {
    vi.mocked(mockApi.deleteCatalogArtifact).mockResolvedValue(undefined);
    open();
    await userEvent.click(
      await screen.findByRole("button", {
        name: "Actions for 1.0.0 android a.apk",
      }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Delete artifact" }),
    );
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Delete artifact" }),
    );
    await waitFor(() =>
      expect(mockApi.deleteCatalogArtifact).toHaveBeenCalledWith(
        "ca_1",
        "art_1",
      ),
    );
  });

  it("shows the changelog in its own cell and every other tag on the tooltip", async () => {
    open();
    // The changelog is a column of its own; no other tag is on screen.
    const cell = await screen.findByRole("button", { name: "first release" });
    expect(screen.getByText("build_type")).not.toBeVisible();
    const row = cell.closest("tr") as HTMLElement;
    const cells = within(row).getAllByRole("cell");
    expect(cells[5]).toContainElement(cell);
    // One line each: Version, Platform, File, Size and Created declare
    // `nowrap`, and the changelog is ellipsed at the column's width.
    for (const c of cells.slice(0, 5))
      expect(c).toHaveStyle({ whiteSpace: "nowrap" });
    expect(cell).toHaveStyle({
      whiteSpace: "nowrap",
      overflow: "hidden",
      textOverflow: "ellipsis",
    });
    await userEvent.hover(cell);
    const tip = await screen.findByRole("tooltip");
    expect(tip).toHaveTextContent("build_type release");
    expect(tip).toHaveTextContent("commit abc1234");
    // The cell shows one ellipsed line, so the tooltip carries the whole.
    expect(tip).toHaveTextContent("changelog first release");
    // Version has a column of its own and is the group's heading.
    expect(tip).not.toHaveTextContent("1.0.0");
  });

  it("folds the whole metadata out under the cell on a tap, and back in", async () => {
    open();
    const toggle = await screen.findByRole("button", { name: "first release" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    // The fold is inside the cell, under the one line it belongs to.
    const cell = toggle.closest("td") as HTMLElement;
    const fold = await within(cell).findByRole("group", {
      name: "Upload metadata",
    });
    expect(fold).toHaveTextContent("build_type release");
    expect(fold).toHaveTextContent("changelog first release");
    // One at a time: the pointer's tooltip stays out of the fold's way.
    await userEvent.hover(toggle);
    expect(screen.queryByRole("tooltip")).toBeNull();
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await waitFor(() => expect(within(cell).queryByRole("group")).toBeNull());
  });

  it("keeps the iOS OTA hint out of the table and in the metadata", async () => {
    vi.mocked(mockApi.catalogApp).mockResolvedValue(APP);
    vi.mocked(mockApi.catalogArtifacts).mockResolvedValue([
      {
        ...ARTIFACTS[0]!,
        platform: "ios",
        objectKey: "apps/ca_1/1.0.0/a.ipa",
        ios: { manifestUrl: "https://cdn.example/m.plist", installUrl: "itms" },
      },
    ]);
    mount(
      <Routes>
        <Route path="/catalog/apps/:id" element={<CatalogAppPage />} />
      </Routes>,
      { client: mockApi, path: "/catalog/apps/ca_1" },
    );
    const toggle = await screen.findByRole("button", { name: "first release" });
    // The hint lives in the changelog cell's metadata now; off an iOS
    // device the install column is not rendered at all.
    await waitFor(() =>
      expect(
        screen.getAllByRole("columnheader").map((h) => h.textContent),
      ).toEqual([
        "Version",
        "Platform",
        "File",
        "Size",
        "Created",
        "Changelog",
        "Actions",
      ]),
    );
    await userEvent.hover(toggle);
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      "open this page on the device",
    );
    // And a phone, which has no hover, taps it out of the fold.
    await userEvent.click(toggle);
    expect(
      await within(toggle.closest("td") as HTMLElement).findByRole("group", {
        name: "Upload metadata",
      }),
    ).toHaveTextContent("open this page on the device");
  });

  it("opens the same tooltip from the keyboard", async () => {
    open();
    // The cell's one line is itself the tooltip target.
    const target = await screen.findByRole("button", { name: "first release" });
    target.focus();
    const tip = await screen.findByRole("tooltip");
    expect(target).toHaveAttribute("aria-describedby", tip.id);
  });

  it("keeps a long unbroken tag value inside the tooltip", async () => {
    const long = Array.from({ length: 9 }, (_, i) => `line ${i}`).join("\n");
    const sha = "a".repeat(64);
    vi.mocked(mockApi.catalogApp).mockResolvedValue(APP);
    vi.mocked(mockApi.catalogArtifacts).mockResolvedValue([
      {
        ...ARTIFACTS[0]!,
        platform: "bin",
        tags: { version: "1.0.0", changelog: long, sha256: sha },
      },
    ]);
    mount(
      <Routes>
        <Route path="/catalog/apps/:id" element={<CatalogAppPage />} />
      </Routes>,
      { client: mockApi, path: "/catalog/apps/ca_1" },
    );
    await userEvent.hover(
      await screen.findByRole("button", { name: /^line 0/ }),
    );
    const tip = await screen.findByRole("tooltip");
    // The ellipsed tail is reachable, and 64 hex characters have to wrap.
    expect(tip).toHaveTextContent("line 8");
    expect(within(tip).getByText(sha, { exact: false })).toHaveStyle({
      wordBreak: "break-word",
    });
  });

  it("names the control when the row has metadata but no changelog", async () => {
    vi.mocked(mockApi.catalogApp).mockResolvedValue(APP);
    vi.mocked(mockApi.catalogArtifacts).mockResolvedValue([
      { ...ARTIFACTS[0]!, tags: { version: "1.0.0", build_type: "release" } },
    ]);
    mount(
      <Routes>
        <Route path="/catalog/apps/:id" element={<CatalogAppPage />} />
      </Routes>,
      { client: mockApi, path: "/catalog/apps/ca_1" },
    );
    // "Metadata of —" is not a name; the em dash is only the visible mark.
    const toggle = await screen.findByRole("button", {
      name: "Upload metadata",
    });
    expect(toggle).toHaveTextContent("—");
  });

  it("renders a dash and no tooltip for an artifact carrying only a version", async () => {
    vi.mocked(mockApi.catalogApp).mockResolvedValue(APP);
    vi.mocked(mockApi.catalogArtifacts).mockResolvedValue([
      { ...ARTIFACTS[0]!, tags: { version: "1.0.0" } },
    ]);
    mount(
      <Routes>
        <Route path="/catalog/apps/:id" element={<CatalogAppPage />} />
      </Routes>,
      { client: mockApi, path: "/catalog/apps/ca_1" },
    );
    const row = (await screen.findByText("a.apk")).closest("tr") as HTMLElement;
    const cell = within(row).getAllByRole("cell")[5]!;
    expect(cell).toHaveTextContent("—");
    await userEvent.hover(cell);
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(within(cell).queryByRole("button")).toBeNull();
  });

  it("keeps two re-uploads of one version, platform and file name apart", async () => {
    vi.mocked(mockApi.catalogApp).mockResolvedValue(APP);
    vi.mocked(mockApi.catalogArtifacts).mockResolvedValue([
      ARTIFACTS[0]!,
      { ...ARTIFACTS[0]!, id: "art_2", objectKey: "apps/ca_1/1.0.0/a.apk" },
    ]);
    mount(
      <Routes>
        <Route path="/catalog/apps/:id" element={<CatalogAppPage />} />
      </Routes>,
      { client: mockApi, path: "/catalog/apps/ca_1" },
    );
    // The id is the only thing that tells the two rows apart.
    for (const id of ["art_1", "art_2"])
      expect(
        await screen.findByRole("button", {
          name: `Actions for 1.0.0 android a.apk ${id}`,
        }),
      ).toBeInTheDocument();
  });

  it("keeps Edit disabled until the settings are known, so a save cannot wipe them", async () => {
    let resolveSettings: (v: unknown) => void = () => {};
    vi.mocked(mockApi.catalogSettings).mockReturnValue(
      new Promise((r) => {
        resolveSettings = r;
      }) as never,
    );
    open();
    const editBtn = await screen.findByRole("button", { name: "Edit" });
    expect(editBtn).toBeDisabled();
    resolveSettings({
      slackHookUrl: "https://hooks.example/x",
      slackChannel: "#ops",
      messageTemplate: null,
      keepRecentVersions: 9,
    });
    await waitFor(() => expect(editBtn).toBeEnabled());
    await userEvent.click(editBtn);
    const drawer = await screen.findByRole("dialog");
    expect(within(drawer).getByLabelText("Slack channel")).toHaveValue("#ops");
    expect(within(drawer).getByLabelText("Keep recent versions")).toHaveValue(
      "9",
    );
  });

  it("deletes the app from the drawer danger zone and returns to the project's catalog", async () => {
    vi.mocked(mockApi.deleteCatalogApp).mockResolvedValue(undefined);
    open();
    await userEvent.click(await screen.findByRole("button", { name: "Edit" }));
    const drawer = await screen.findByRole("dialog");
    await userEvent.click(
      within(drawer).getByRole("button", { name: "Delete app" }),
    );
    const modal = (await screen.findByText("Delete app?")).closest(
      '[role="dialog"]',
    ) as HTMLElement;
    await userEvent.click(
      within(modal).getByRole("button", { name: "Delete app" }),
    );
    await waitFor(() =>
      expect(mockApi.deleteCatalogApp).toHaveBeenCalledWith("ca_1"),
    );
    expect(await screen.findByText("project tab")).toBeInTheDocument();
  });

  it("hides upload, edit and cleanup from a seatless admin", async () => {
    vi.mocked(mockApi.team).mockResolvedValue({ ...TEAM, role: "admin" });
    open();
    await screen.findByRole("heading", { name: "my-game" });
    expect(await screen.findByText(/Read-only/)).toBeInTheDocument();
    expect(screen.queryByText("Upload artifact")).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Run cleanup" })).toBeNull();
    expect(screen.queryByRole("button", { name: "More actions" })).toBeNull();
    expect(mockApi.catalogSettings).not.toHaveBeenCalled();
  });
});
