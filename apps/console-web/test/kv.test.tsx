import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../src/api";
import type { KvCollectionDetail, KvEntry, TeamDetail } from "../src/types";

/*
 * The collection page (`/kv/:id`): what a member sees and may do, and the
 * three read-only standings (encrypted, seatless admin, no seat). Payloads
 * are pinned because the console route stores `valueText` verbatim and
 * treats `ttl`/`ifVersion` presence as meaning.
 */

const mockApi = {
  me: vi.fn(),
  logout: vi.fn(),
  loginUrl: vi.fn(() => "/auth/github/start"),
  setUnauthorizedHandler: vi.fn(),
  team: vi.fn(),
  kv: vi.fn(),
  updateKv: vi.fn(),
  deleteKv: vi.fn(),
  kvEntries: vi.fn(),
  putKvEntry: vi.fn(),
  deleteKvEntry: vi.fn(),
  deleteKvOwner: vi.fn(),
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

const { KvCollectionPage } = await import("../src/pages/KvCollection");
const { ApiError } = await import("../src/api");
const { mount } = await import("./wrap");

const TEAM: TeamDetail = { id: "team_1", name: "studio", role: "member" };
const NOW = Math.floor(Date.now() / 1000);
const OWNER_A = "a".repeat(32);
const OWNER_B = "b".repeat(32);
const COL: KvCollectionDetail = {
  id: "kv_1",
  name: "profiles",
  description: "public profiles",
  readScope: "project",
  writeScope: "user",
  encrypted: false,
  maxEntries: 10000,
  maxEntriesPerOwner: 100,
  entries: 2,
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
    metaPath: "/kv/kv_1",
    entriesPath: "/kv/kv_1/entries",
    ownerPath: "/kv/kv_1/u/{ownerId}/entries",
  },
};
const E1: KvEntry = {
  owner: OWNER_A,
  key: "profile",
  version: 3,
  bytes: 11,
  expiresAt: null,
  channelId: "auth_1",
  updatedAt: NOW - 120,
  valueText: '{"name":"A"}',
};
const E2: KvEntry = {
  owner: OWNER_B,
  key: "profile",
  version: 1,
  bytes: 4,
  expiresAt: NOW + 7200,
  channelId: null,
  updatedAt: NOW - 60,
  valueText: "null",
};

function open(col = COL) {
  vi.mocked(mockApi.kv).mockResolvedValue(col);
  return mount(
    <Routes>
      <Route path="/kv/:id" element={<KvCollectionPage />} />
      <Route
        path="/teams/:team/projects/:prj/:tab"
        element={<p>project tab</p>}
      />
    </Routes>,
    { client: mockApi, path: "/kv/kv_1" },
  );
}

const headers = () =>
  screen.getAllByRole("columnheader").map((h) => h.textContent);
// `Collapse` keeps the fold's copy of a cell's text mounted (display:none),
// so a text query sees two nodes per clipped cell: the first is the cell.
const rowOf = (text: string) => screen.getAllByText(text)[0]!.closest("tr")!;
const firstText = async (text: string) =>
  (await screen.findAllByText(text))[0]!;
const cells = (tr: HTMLElement) =>
  within(tr)
    .getAllByRole("cell")
    // A clipped cell reads its text twice (button + hidden fold).
    .map(
      (c) =>
        within(c).queryAllByRole("button")[0]?.textContent ?? c.textContent,
    );

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(mockApi.me).mockResolvedValue({
    id: "u1",
    login: "alice",
    role: "member",
    via: "session",
  });
  vi.mocked(mockApi.team).mockResolvedValue(TEAM);
  vi.mocked(mockApi.kvEntries).mockResolvedValue({ entries: [E1, E2] });
});

describe("KvCollectionPage", () => {
  it("shows the shape, the API block and the entries with their values", async () => {
    open();
    expect(
      await screen.findByRole("heading", { name: "profiles" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "dungeon" })).toHaveAttribute(
      "href",
      "/teams/team_1/projects/prj_1",
    );
    expect(screen.getByText("read: project")).toBeInTheDocument();
    expect(screen.getByText("write: user")).toBeInTheDocument();
    expect(
      screen.getByText(/2 entries · at most 10000 \(100 per owner\)/),
    ).toBeInTheDocument();
    // One copyable block, `name=value` lines, the owner path included.
    expect(screen.getByLabelText("KV API").textContent).toBe(
      [
        "base=https://doc-dev.example",
        "meta=/kv/kv_1",
        "entries=/kv/kv_1/entries",
        "owner=/kv/kv_1/u/{ownerId}/entries",
      ].join("\n"),
    );
    await firstText('{"name":"A"}');
    expect(headers()).toEqual([
      "Key",
      "Owner",
      "Value",
      "Bytes",
      "Version",
      "Expires",
      "Updated",
      "Actions",
    ]);
    expect(cells(rowOf('{"name":"A"}')).slice(2, 6)).toEqual([
      '{"name":"A"}',
      "11",
      "3",
      "—",
    ]);
    expect(cells(rowOf("null"))[5]).toBe("in 2h");
    // The owner filter is a request parameter, and no filter sends nothing.
    expect(mockApi.kvEntries).toHaveBeenCalledWith("kv_1", {});
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });

  it("loads the next page under the same filters and drops it on reload", async () => {
    vi.mocked(mockApi.kvEntries)
      .mockResolvedValueOnce({ entries: [E1], nextCursor: "c1" })
      .mockResolvedValueOnce({ entries: [E2] })
      .mockResolvedValue({ entries: [E1] });
    open();
    await firstText('{"name":"A"}');
    await userEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(mockApi.kvEntries).toHaveBeenLastCalledWith("kv_1", {
      cursor: "c1",
    });
    expect(await firstText("null")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
    // A filter change refetches page one and forgets the appended rows.
    await userEvent.type(screen.getByLabelText("Key prefix"), "pro");
    await waitFor(() =>
      expect(mockApi.kvEntries).toHaveBeenLastCalledWith("kv_1", {
        prefix: "pro",
      }),
    );
    await waitFor(() => expect(screen.queryAllByText("null")).toHaveLength(0));
  });

  it("puts a new entry with owner, key, JSON value and ttl, then reloads", async () => {
    vi.mocked(mockApi.putKvEntry).mockResolvedValue({
      owner: "c".repeat(32),
      key: "profile",
      version: 1,
      bytes: 2,
      created: true,
    });
    open();
    await firstText('{"name":"A"}');
    await userEvent.click(screen.getByRole("button", { name: "New entry" }));
    const drawer = await screen.findByRole("dialog");
    const submit = within(drawer).getByRole("button", { name: "Put entry" });
    expect(submit).toBeDisabled();
    await userEvent.type(
      within(drawer).getByLabelText(/^Owner/),
      "c".repeat(32),
    );
    await userEvent.type(within(drawer).getByLabelText(/^Key/), "bad/key");
    await userEvent.type(within(drawer).getByLabelText(/^Value/), "{{");
    expect(within(drawer).getByText("Not valid JSON.")).toBeInTheDocument();
    expect(submit).toBeDisabled();
    await userEvent.clear(within(drawer).getByLabelText(/^Value/));
    await userEvent.type(within(drawer).getByLabelText(/^Value/), "{{}");
    expect(submit).toBeDisabled(); // the key still breaks the grammar
    await userEvent.clear(within(drawer).getByLabelText(/^Key/));
    await userEvent.type(within(drawer).getByLabelText(/^Key/), "profile");
    await userEvent.type(within(drawer).getByLabelText(/^TTL/), "60");
    expect(submit).toBeEnabled();
    await userEvent.click(submit);
    await waitFor(() =>
      expect(mockApi.putKvEntry).toHaveBeenCalledWith("kv_1", "profile", {
        owner: "c".repeat(32),
        valueText: "{}",
        ttl: 60,
      }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(mockApi.kvEntries).toHaveBeenCalledTimes(2);
    expect(mockApi.kv).toHaveBeenCalledTimes(2);
  });

  it("edits an entry against the version it was opened on", async () => {
    vi.mocked(mockApi.putKvEntry).mockResolvedValue({
      owner: OWNER_A,
      key: "profile",
      version: 4,
      bytes: 12,
      created: false,
    });
    open();
    await firstText('{"name":"A"}');
    await userEvent.click(
      screen.getByRole("button", { name: `Actions for ${OWNER_A} profile` }),
    );
    await userEvent.click(screen.getByRole("menuitem", { name: "Edit entry" }));
    const drawer = await screen.findByRole("dialog");
    expect(within(drawer).getByLabelText(/^Key/)).toBeDisabled();
    expect(within(drawer).getByLabelText(/^Owner/)).toBeDisabled();
    const value = within(drawer).getByLabelText(/^Value/);
    expect(value).toHaveValue('{"name":"A"}');
    await userEvent.clear(value);
    await userEvent.type(value, '{{"name":"AA"}');
    await userEvent.click(within(drawer).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(mockApi.putKvEntry).toHaveBeenCalledWith("kv_1", "profile", {
        owner: OWNER_A,
        valueText: '{"name":"AA"}',
        ifVersion: 3,
      }),
    );
  });

  it("folds a clipped cell open on tap with the full text selectable", async () => {
    open();
    await firstText('{"name":"A"}');
    expect(screen.queryByRole("group", { name: "Full owner" })).toBeNull();
    const cell = screen.getAllByRole("button", { expanded: false })[0]!;
    await userEvent.click(cell);
    const fold = await screen.findByRole("group", { name: /^Full / });
    expect(fold).toHaveStyle({ userSelect: "all" });
    expect(cell).toHaveAttribute("aria-expanded", "true");
    expect(cell).toHaveAttribute("aria-controls", fold.id);
  });

  it("names the winning version on a compare-and-set miss and refreshes the row", async () => {
    const miss = Object.assign(
      new ApiError(409, "conflict", "version mismatch"),
      {
        details: { current: 5 },
      },
    );
    vi.mocked(mockApi.putKvEntry).mockRejectedValue(miss);
    open();
    await firstText('{"name":"A"}');
    await userEvent.click(
      screen.getByRole("button", { name: `Actions for ${OWNER_A} profile` }),
    );
    await userEvent.click(screen.getByRole("menuitem", { name: "Edit entry" }));
    const drawer = await screen.findByRole("dialog");
    await userEvent.click(within(drawer).getByRole("button", { name: "Save" }));
    expect(
      await within(drawer).findByText(/now at version 5; close and reopen/),
    ).toBeInTheDocument();
    await waitFor(() => expect(mockApi.kvEntries).toHaveBeenCalledTimes(2));
  });

  it("deletes an entry from the row menu after a confirmation", async () => {
    vi.mocked(mockApi.deleteKvEntry).mockResolvedValue(undefined);
    open();
    await firstText("null");
    await userEvent.click(
      screen.getByRole("button", { name: `Actions for ${OWNER_B} profile` }),
    );
    await userEvent.click(
      screen.getByRole("menuitem", { name: "Delete entry" }),
    );
    const modal = (
      await screen.findByText(`Delete ${OWNER_B} profile?`)
    ).closest('[role="dialog"]') as HTMLElement;
    await userEvent.click(
      within(modal).getByRole("button", { name: "Delete entry" }),
    );
    await waitFor(() =>
      expect(mockApi.deleteKvEntry).toHaveBeenCalledWith(
        "kv_1",
        "profile",
        OWNER_B,
      ),
    );
  });

  it("clears one owner once the owner filter names one", async () => {
    vi.mocked(mockApi.deleteKvOwner).mockResolvedValue({
      deleted: 2,
      truncated: false,
    });
    open();
    await firstText("null");
    const clear = screen.getByRole("button", { name: "Clear owner" });
    expect(clear).toBeDisabled();
    await userEvent.type(screen.getByLabelText("Owner"), OWNER_A);
    await waitFor(() =>
      expect(mockApi.kvEntries).toHaveBeenLastCalledWith("kv_1", {
        owner: OWNER_A,
      }),
    );
    await waitFor(() => expect(clear).toBeEnabled());
    await userEvent.click(clear);
    const modal = (await screen.findByText(`Clear ${OWNER_A}?`)).closest(
      '[role="dialog"]',
    ) as HTMLElement;
    await userEvent.click(
      within(modal).getByRole("button", { name: "Clear owner" }),
    );
    await waitFor(() =>
      expect(mockApi.deleteKvOwner).toHaveBeenCalledWith("kv_1", OWNER_A),
    );
  });

  it("keeps values and writes out of an encrypted collection but still deletes", async () => {
    vi.mocked(mockApi.kvEntries).mockResolvedValue({
      entries: [{ ...E1, valueText: undefined }],
    });
    open({ ...COL, encrypted: true });
    await screen.findByRole("heading", { name: "profiles" });
    expect(screen.getByText("encrypted")).toBeInTheDocument();
    expect(
      screen.getByText(/^Encrypted: values are written/),
    ).toBeInTheDocument();
    await firstText(OWNER_A);
    expect(headers()).not.toContain("Value");
    expect(screen.queryByRole("button", { name: "New entry" })).toBeNull();
    await userEvent.click(
      screen.getByRole("button", { name: `Actions for ${OWNER_A} profile` }),
    );
    expect(screen.queryByRole("menuitem", { name: "Edit entry" })).toBeNull();
    expect(
      screen.getByRole("menuitem", { name: "Delete entry" }),
    ).toBeInTheDocument();
  });

  it("is a shared namespace without an owner column, filter or clear button", async () => {
    vi.mocked(mockApi.kvEntries).mockResolvedValue({
      entries: [{ ...E1, owner: undefined }],
    });
    open({
      ...COL,
      writeScope: "project",
      api: { ...COL.api, ownerPath: undefined },
    });
    await firstText('{"name":"A"}');
    expect(headers()).toEqual([
      "Key",
      "Value",
      "Bytes",
      "Version",
      "Expires",
      "Updated",
      "Actions",
    ]);
    expect(screen.queryByLabelText("Owner")).toBeNull();
    expect(screen.queryByRole("button", { name: "Clear owner" })).toBeNull();
    expect(screen.getByLabelText("KV API").textContent).not.toContain("owner=");
    await userEvent.click(screen.getByRole("button", { name: "New entry" }));
    const drawer = await screen.findByRole("dialog");
    expect(within(drawer).queryByLabelText(/^Owner/)).toBeNull();
  });

  it("warns when the stage has no state stack and when both scopes are team", async () => {
    open({
      ...COL,
      readScope: "team",
      writeScope: "team",
      api: { ...COL.api, configured: false, ownerPath: undefined },
    });
    await screen.findByRole("heading", { name: "profiles" });
    expect(screen.getByText(/no state stack deployed/)).toBeInTheDocument();
    expect(screen.getByText(/Both scopes are team/)).toBeInTheDocument();
  });

  it("saves only the changed fields of the collection and never a scope", async () => {
    const { entries: _count, ...written } = COL;
    vi.mocked(mockApi.updateKv).mockResolvedValue({
      ...written,
      name: "public-profiles",
      maxEntries: 500,
    });
    open();
    await userEvent.click(await screen.findByRole("button", { name: "Edit" }));
    const drawer = await screen.findByRole("dialog");
    expect(
      within(drawer).getByText(/cannot be changed later/),
    ).toBeInTheDocument();
    const name = within(drawer).getByLabelText(/^Name/);
    await userEvent.clear(name);
    await userEvent.type(name, "public-profiles");
    const cap = within(drawer).getByLabelText(/^Max entries \*$/);
    await userEvent.clear(cap);
    await userEvent.type(cap, "500");
    await userEvent.click(within(drawer).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(mockApi.updateKv).toHaveBeenCalledWith("kv_1", {
        name: "public-profiles",
        maxEntries: 500,
      }),
    );
    expect(
      await screen.findByRole("heading", { name: "public-profiles" }),
    ).toBeInTheDocument();
    // The write answers no count; the header keeps the one it had.
    expect(screen.getByText(/2 entries · at most 500/)).toBeInTheDocument();
  });

  it("deletes from the drawer danger zone and returns to the project's kv tab", async () => {
    vi.mocked(mockApi.deleteKv).mockResolvedValue(undefined);
    open();
    await userEvent.click(await screen.findByRole("button", { name: "Edit" }));
    const drawer = await screen.findByRole("dialog");
    await userEvent.click(
      within(drawer).getByRole("button", { name: "Delete collection" }),
    );
    const modal = (await screen.findByText("Delete collection?")).closest(
      '[role="dialog"]',
    ) as HTMLElement;
    await userEvent.click(
      within(modal).getByRole("button", { name: "Delete collection" }),
    );
    await waitFor(() => expect(mockApi.deleteKv).toHaveBeenCalledWith("kv_1"));
    expect(await screen.findByText("project tab")).toBeInTheDocument();
  });

  it("is read-only for a seatless admin, values included", async () => {
    vi.mocked(mockApi.team).mockResolvedValue({ ...TEAM, role: "admin" });
    vi.mocked(mockApi.kvEntries).mockResolvedValue({
      entries: [{ ...E1, valueText: undefined }],
    });
    open();
    await screen.findByRole("heading", { name: "profiles" });
    expect(await screen.findByText(/Read-only/)).toBeInTheDocument();
    await firstText(OWNER_A);
    expect(headers()).not.toContain("Value");
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.queryByRole("button", { name: "New entry" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Actions for/ })).toBeNull();
  });
});
