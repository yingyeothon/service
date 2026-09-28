import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../src/api";
import type {
  AssetBundleDetail,
  AssetFile,
  LimitsView,
  TeamDetail,
} from "../src/types";

const mockApi = {
  me: vi.fn(),
  logout: vi.fn(),
  loginUrl: vi.fn(() => "/auth/github/start"),
  setUnauthorizedHandler: vi.fn(),
  team: vi.fn(),
  assetBundle: vi.fn(),
  assetVersion: vi.fn(),
  updateAssetBundle: vi.fn(),
  deleteAssetBundle: vi.fn(),
  deleteAssetVersion: vi.fn(),
  uploadAssetFile: vi.fn(),
  assetLiveFiles: vi.fn(),
  deleteAssetFiles: vi.fn(),
  limits: vi.fn(),
  requestLimit: vi.fn(),
  cancelLimitRequest: vi.fn(),
} as unknown as ApiClient;

vi.mock("../src/api", () => ({
  api: mockApi,
  ApiError: class extends Error {},
}));

const { AssetBundlePage } = await import("../src/pages/AssetBundle");
const { mount } = await import("./wrap");

const TEAM: TeamDetail = { id: "team_1", name: "studio", role: "member" };
const BUNDLE: AssetBundleDetail = {
  id: "ab_1",
  name: "dungeon-maps",
  description: "maps",
  mode: "versioned",
  createdAt: 0,
  updatedAt: 0,
  teamId: "team_1",
  teamName: "studio",
  projectId: "prj_1",
  projectName: "dungeon",
  createdBy: "alice",
  files: 2,
  bytes: 4096,
  versions: [{ version: "v1", files: 2, bytes: 4096, createdAt: 0 }],
};

const MiB = 1024 * 1024;
const LIMITS: LimitsView = {
  scope: { kind: "bundle", id: "ab_1" },
  teamId: "team_1",
  limits: [
    {
      key: "asset.fileBytes",
      unit: "bytes",
      soft: 2 * MiB,
      hard: 256 * MiB,
      effective: 8 * MiB,
      usage: 10,
      override: {
        value: 8 * MiB,
        expiresAt: null,
        note: "big tilesets",
        requestId: "lr_1",
        grantedBy: "u9",
        grantedByLogin: "boss",
        grantedAt: 0,
      },
    },
    {
      key: "asset.bundleBytes",
      unit: "bytes",
      soft: 20 * MiB,
      hard: 3072 * MiB,
      effective: 20 * MiB,
      usage: 4096,
      override: null,
    },
  ],
  pending: [],
};

const file = (path: string): AssetFile => ({
  id: `f_${path}`,
  bundleId: "ab_1",
  version: "v1",
  path,
  url: `https://cdn.example/assets/ab_1/v1/${path}`,
  objectKey: "k",
  contentType: "application/json",
  size: 10,
  hash: null,
  sha256: null,
  mutable: false,
  staleSince: null,
  createdAt: 0,
});

function open(bundle = BUNDLE) {
  vi.mocked(mockApi.assetBundle).mockResolvedValue(bundle);
  return mount(
    <Routes>
      <Route path="/assets/:id" element={<AssetBundlePage />} />
      <Route
        path="/teams/:team/projects/:prj/:tab"
        element={<p>project tab</p>}
      />
    </Routes>,
    { client: mockApi, path: "/assets/ab_1" },
  );
}

describe("AssetBundlePage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(mockApi.me).mockResolvedValue({
      id: "u1",
      login: "alice",
      role: "member",
      via: "session",
    });
    vi.mocked(mockApi.team).mockResolvedValue(TEAM);
    vi.mocked(mockApi.limits).mockResolvedValue(LIMITS);
    vi.mocked(mockApi.assetVersion).mockResolvedValue({
      bundle: "dungeon-maps",
      bundleId: "ab_1",
      version: "v1",
      files: [file("maps/a.json")],
      next: null,
    });
  });

  it("lists versions, opens a version's files and shows the CDN prefix", async () => {
    open();
    expect(
      await screen.findByRole("heading", { name: "dungeon-maps" }),
    ).toBeInTheDocument();
    expect(screen.getByText("v1")).toBeInTheDocument();
    expect(screen.getByText("assets/ab_1/")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Show files" }));
    await waitFor(() =>
      expect(mockApi.assetVersion).toHaveBeenCalledWith("ab_1", "v1", {
        cursor: undefined,
      }),
    );
    expect(await screen.findByText("maps/a.json")).toBeInTheDocument();
    for (const col of ["Path", "Type", "URL"])
      expect(
        screen.getByRole("columnheader", { name: col }),
      ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Hide files" }),
    ).toBeInTheDocument();
  });

  it("pages a version's files with Load more", async () => {
    vi.mocked(mockApi.assetVersion)
      .mockResolvedValueOnce({
        bundle: "dungeon-maps",
        bundleId: "ab_1",
        version: "v1",
        files: [file("maps/a.json")],
        next: "maps/a.json",
      })
      .mockResolvedValueOnce({
        bundle: "dungeon-maps",
        bundleId: "ab_1",
        version: "v1",
        files: [file("maps/b.json")],
        next: null,
      });
    open();
    await userEvent.click(
      await screen.findByRole("button", { name: "Show files" }),
    );
    expect(await screen.findByText("maps/a.json")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(await screen.findByText("maps/b.json")).toBeInTheDocument();
    expect(mockApi.assetVersion).toHaveBeenLastCalledWith("ab_1", "v1", {
      cursor: "maps/a.json",
    });
    // Both pages stay; the last one had no cursor, so the button goes.
    expect(screen.getByText("maps/a.json")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });

  it("keeps a versioned bundle's sections and lists the binary extensions", async () => {
    open();
    await screen.findByRole("heading", { name: "dungeon-maps" });
    expect(screen.getByText("versioned")).toBeInTheDocument();
    expect(
      await screen.findByText(/\.csv \.db \.sqlite \.bin \.zip/),
    ).toBeInTheDocument();
    for (const title of ["Publish a version", "Versions", "Publishing a map"])
      expect(screen.getByRole("heading", { name: title })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Files" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Sync" })).toBeNull();
    expect(mockApi.assetLiveFiles).not.toHaveBeenCalled();
  });

  it("states the bundle's effective limits instead of fixed numbers", async () => {
    open();
    await screen.findByRole("heading", { name: "dungeon-maps" });
    expect(mockApi.limits).toHaveBeenCalledWith("bundle:ab_1");
    // Binary units, as the limits are defined and asked for.
    expect(await screen.findByText(/4 KiB of 20 MiB/)).toBeInTheDocument();
    expect(screen.getByText(/up to 8 MiB per file/)).toBeInTheDocument();
    const limits = screen
      .getByRole("heading", { name: "Limits" })
      .closest("section")!;
    expect(within(limits).getByText("File size")).toBeInTheDocument();
    expect(within(limits).getByText("256 MiB")).toBeInTheDocument();
    expect(
      within(limits).getByRole("button", { name: /^raised/ }),
    ).toBeInTheDocument();
  });

  it("shows the empty state", async () => {
    open({ ...BUNDLE, versions: [] });
    expect(
      await screen.findByText("No versions published yet."),
    ).toBeInTheDocument();
  });

  it("saves the description from the edit drawer and deletes a version from its row menu", async () => {
    vi.mocked(mockApi.updateAssetBundle).mockResolvedValue({
      ...BUNDLE,
      description: "all maps",
    });
    vi.mocked(mockApi.deleteAssetVersion).mockResolvedValue(undefined);
    open();
    await userEvent.click(await screen.findByRole("button", { name: "Edit" }));
    const drawer = await screen.findByRole("dialog");
    const desc = within(drawer).getByLabelText("Description");
    await userEvent.clear(desc);
    await userEvent.type(desc, "all maps");
    await userEvent.click(within(drawer).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(mockApi.updateAssetBundle).toHaveBeenCalledWith("ab_1", {
        description: "all maps",
      }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await userEvent.click(
      screen.getByRole("button", { name: "Actions for v1" }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Delete version" }),
    );
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Delete version" }),
    );
    await waitFor(() =>
      expect(mockApi.deleteAssetVersion).toHaveBeenCalledWith(
        "ab_1",
        "v1",
        expect.any(Function),
      ),
    );
  });

  it("deletes the bundle from the drawer danger zone and returns to the project's assets", async () => {
    vi.mocked(mockApi.deleteAssetBundle).mockResolvedValue(undefined);
    open();
    await userEvent.click(await screen.findByRole("button", { name: "Edit" }));
    const drawer = await screen.findByRole("dialog");
    await userEvent.click(
      within(drawer).getByRole("button", { name: "Delete bundle" }),
    );
    const modal = (await screen.findByText("Delete bundle?")).closest(
      '[role="dialog"]',
    ) as HTMLElement;
    await userEvent.click(
      within(modal).getByRole("button", { name: "Delete bundle" }),
    );
    await waitFor(() =>
      expect(mockApi.deleteAssetBundle).toHaveBeenCalledWith(
        "ab_1",
        expect.any(Function),
      ),
    );
    expect(await screen.findByText("project tab")).toBeInTheDocument();
  });

  it("says how far a long bundle delete has got", async () => {
    let finish: () => void = () => undefined;
    vi.mocked(mockApi.deleteAssetBundle).mockImplementation(
      async (_id: string, onProgress?: (n: number) => void) => {
        onProgress?.(2000);
        await new Promise<void>((r) => (finish = r));
      },
    );
    open();
    await userEvent.click(await screen.findByRole("button", { name: "Edit" }));
    const drawer = await screen.findByRole("dialog");
    await userEvent.click(
      within(drawer).getByRole("button", { name: "Delete bundle" }),
    );
    const modal = (await screen.findByText("Delete bundle?")).closest(
      '[role="dialog"]',
    ) as HTMLElement;
    await userEvent.click(
      within(modal).getByRole("button", { name: "Delete bundle" }),
    );
    expect(
      await screen.findByText("Deleting… 2000 files so far."),
    ).toBeInTheDocument();
    finish();
    expect(await screen.findByText("project tab")).toBeInTheDocument();
  });

  it("hides publishing from a seatless admin", async () => {
    vi.mocked(mockApi.team).mockResolvedValue({ ...TEAM, role: "admin" });
    open();
    await screen.findByRole("heading", { name: "dungeon-maps" });
    expect(await screen.findByText(/Read-only/)).toBeInTheDocument();
    expect(screen.queryByText("Publish a version")).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.queryByRole("button", { name: "More actions" })).toBeNull();
  });

  describe("a live bundle", () => {
    const LIVE: AssetBundleDetail = {
      ...BUNDLE,
      name: "content",
      mode: "live",
      versions: [],
      files: 2,
    };
    const liveFile = (path: string, o: Partial<AssetFile> = {}): AssetFile => ({
      ...file(path),
      version: "",
      url: `https://cdn.example/assets/ab_1/${path}`,
      sha256: "ab".repeat(32),
      ...o,
    });

    beforeEach(() => {
      vi.mocked(mockApi.assetLiveFiles).mockResolvedValue({
        bundleId: "ab_1",
        mode: "live",
        version: null,
        files: [
          liveFile("db/songs.sqlite", {
            contentType: "application/octet-stream",
          }),
          liveFile("selects.json", { mutable: true, staleSince: 5 }),
        ],
        next: null,
      });
    });

    it("lists its files and shows the sync command instead of publishing", async () => {
      open(LIVE);
      await screen.findByRole("heading", { name: "content" });
      expect(screen.getByText("live")).toBeInTheDocument();
      expect(
        await screen.findByRole("heading", { name: "Files" }),
      ).toBeInTheDocument();
      for (const title of ["Publish a version", "Versions", "Publishing a map"])
        expect(screen.queryByRole("heading", { name: title })).toBeNull();
      expect(mockApi.assetVersion).not.toHaveBeenCalled();
      expect(
        screen.getByText(
          "yyt asset sync content <dir> --mutable manifest.json --prune",
        ),
      ).toBeInTheDocument();
      await waitFor(() =>
        expect(mockApi.assetLiveFiles).toHaveBeenCalledWith("ab_1", {
          cursor: undefined,
        }),
      );
      for (const col of ["Path", "Size", "SHA-256", "Flags"])
        expect(
          screen.getByRole("columnheader", { name: col }),
        ).toBeInTheDocument();
      const open1 = await screen.findByRole("link", {
        name: "Open db/songs.sqlite",
      });
      expect(open1).toHaveAttribute(
        "href",
        "https://cdn.example/assets/ab_1/db/songs.sqlite",
      );
      // No Type column: the table fits the body a 1080 px window leaves.
      expect(
        screen.queryByRole("columnheader", { name: "Type" }),
      ).not.toBeInTheDocument();
      const other = screen
        .getByRole("link", { name: "Open selects.json" })
        .closest("tr")!;
      // Both flags show.
      expect(within(other).getByText("mutable")).toBeTruthy();
      expect(within(other).getByText("stale")).toBeTruthy();
    });

    it("deletes one file from its row menu after a warning", async () => {
      vi.mocked(mockApi.deleteAssetFiles).mockResolvedValue({
        deleted: ["db/songs.sqlite"],
        missing: [],
        skipped: [],
        failed: [],
      });
      open(LIVE);
      await userEvent.click(
        await screen.findByRole("button", {
          name: "Actions for db/songs.sqlite",
        }),
      );
      await userEvent.click(
        await screen.findByRole("menuitem", { name: "Delete file" }),
      );
      const dialog = await screen.findByRole("dialog");
      expect(within(dialog).getByText(/400 days/)).toBeInTheDocument();
      await userEvent.click(
        within(dialog).getByRole("button", { name: "Delete file" }),
      );
      await waitFor(() =>
        expect(mockApi.deleteAssetFiles).toHaveBeenCalledWith("ab_1", [
          "db/songs.sqlite",
        ]),
      );
      // The list and the bundle totals reload.
      await waitFor(() =>
        expect(mockApi.assetLiveFiles).toHaveBeenCalledTimes(2),
      );
      expect(mockApi.assetBundle).toHaveBeenCalledTimes(2);
    });

    it("says so when the object could not be deleted", async () => {
      vi.mocked(mockApi.deleteAssetFiles).mockResolvedValue({
        deleted: [],
        missing: [],
        skipped: [],
        failed: ["selects.json"],
      });
      open(LIVE);
      await userEvent.click(
        await screen.findByRole("button", { name: "Actions for selects.json" }),
      );
      await userEvent.click(
        await screen.findByRole("menuitem", { name: "Delete file" }),
      );
      const dialog = await screen.findByRole("dialog");
      // A mutable file has no tombstone to warn about.
      expect(within(dialog).queryByText(/400 days/)).toBeNull();
      await userEvent.click(
        within(dialog).getByRole("button", { name: "Delete file" }),
      );
      expect(
        await screen.findByText("selects.json could not be deleted; try again"),
      ).toBeInTheDocument();
    });

    it("hides the sync command and the row menu from a seatless admin", async () => {
      vi.mocked(mockApi.team).mockResolvedValue({ ...TEAM, role: "admin" });
      open(LIVE);
      expect(await screen.findByText(/Read-only/)).toBeInTheDocument();
      await screen.findByRole("link", { name: "Open selects.json" });
      expect(screen.queryByRole("heading", { name: "Sync" })).toBeNull();
      expect(
        screen.queryByRole("button", { name: "Actions for selects.json" }),
      ).toBeNull();
    });
  });
});
