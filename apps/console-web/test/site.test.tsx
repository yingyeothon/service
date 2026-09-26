import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../src/api";
import type { SiteDetail, TeamDetail } from "../src/types";

const mockApi = {
  me: vi.fn(),
  logout: vi.fn(),
  loginUrl: vi.fn(() => "/auth/github/start"),
  setUnauthorizedHandler: vi.fn(),
  team: vi.fn(),
  site: vi.fn(),
  updateSite: vi.fn(),
  deleteSite: vi.fn(),
  deploySite: vi.fn(),
} as unknown as ApiClient;

vi.mock("../src/api", () => ({
  api: mockApi,
  ApiError: class extends Error {},
}));

const { SitePage, SITE_SHARED_ORIGIN_WARNING } =
  await import("../src/pages/Site");
const { mount } = await import("./wrap");

const TEAM: TeamDetail = { id: "team_1", name: "studio", role: "member" };
const SITE: SiteDetail = {
  id: "site_1",
  name: "game-web",
  slug: "abc123",
  description: "the client",
  publicUrl: "https://g.yyt.life/abc123/",
  basePath: "/abc123/",
  currentDeployId: "dep_1",
  busy: false,
  createdAt: 0,
  updatedAt: 0,
  teamId: "team_1",
  teamName: "studio",
  projectId: "prj_1",
  projectName: "dungeon",
  createdBy: "alice",
  currentDeploy: null,
  warning: "",
  deploys: [
    {
      id: "dep_1",
      siteId: "site_1",
      status: "live",
      zipBytes: 10,
      bytes: 2048,
      files: 3,
      error: null,
      createdBy: "alice",
      createdAt: 0,
      updatedAt: 0,
      expiresAt: 0,
    },
  ],
};

/** The same site as the API with site names answers it (dev host on). */
const NAMED_API: SiteDetail = {
  ...SITE,
  domain: null,
  hostUrl: "https://abc123.dev-g.yyt.life/",
  hostSuffix: "dev-g.yyt.life",
  movingTo: null,
  publicUrl: "https://dev-g.yyt.life/abc123/",
};
const NAMED: SiteDetail = {
  ...NAMED_API,
  slug: "my-game",
  domain: "my-game",
  basePath: "/my-game/",
  hostUrl: "https://my-game.dev-g.yyt.life/",
  publicUrl: "https://dev-g.yyt.life/my-game/",
};

/** An `ApiError` as the client builds it (the mock class carries no fields). */
const apiError = (status: number, message: string, details?: unknown) =>
  Object.assign(new Error(message), { status, code: "x", details });

async function openEdit() {
  await userEvent.click(await screen.findByRole("button", { name: "Edit" }));
  return screen.findByRole("dialog");
}

function open(site = SITE) {
  vi.mocked(mockApi.site).mockResolvedValue(site);
  return mount(
    <Routes>
      <Route path="/sites/:id" element={<SitePage />} />
      <Route
        path="/teams/:team/projects/:prj/:tab"
        element={<p>project tab</p>}
      />
    </Routes>,
    { client: mockApi, path: "/sites/site_1" },
  );
}

describe("SitePage", () => {
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
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Fake timers that still advance on their own, so `find*` keeps working. */
  function pollClock() {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    return {
      user: userEvent.setup({ advanceTimers: vi.advanceTimersByTime }),
      /** One 3 s poll of the site page. */
      poll: () => act(() => vi.advanceTimersByTimeAsync(3000)),
    };
  }

  const MOVING: SiteDetail = { ...NAMED_API, busy: true, movingTo: "my-game" };

  it("shows the crumbs, the public URL, the warning and the deploys", async () => {
    open();
    expect(
      await screen.findByRole("heading", { name: "game-web" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "dungeon" })).toHaveAttribute(
      "href",
      "/teams/team_1/projects/prj_1",
    );
    expect(
      screen.getByRole("link", { name: "https://g.yyt.life/abc123/" }),
    ).toHaveAttribute("target", "_blank");
    expect(screen.getByText(SITE_SHARED_ORIGIN_WARNING)).toBeInTheDocument();
    for (const col of [
      "Deploy id",
      "Status",
      "Files",
      "Size",
      "Error",
      "Created",
    ])
      expect(
        screen.getByRole("columnheader", { name: col }),
      ).toBeInTheDocument();
    expect(screen.getByText("live")).toBeInTheDocument();
    expect(screen.getAllByText("/abc123/").length).toBeGreaterThan(0);
  });

  it("saves only the changed fields from the edit drawer", async () => {
    vi.mocked(mockApi.updateSite).mockResolvedValue({ ...SITE, name: "web" });
    open();
    await userEvent.click(await screen.findByRole("button", { name: "Edit" }));
    const drawer = await screen.findByRole("dialog");
    const name = within(drawer).getByLabelText(/^Name/);
    await userEvent.clear(name);
    await userEvent.type(name, "web");
    await userEvent.click(within(drawer).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(mockApi.updateSite).toHaveBeenCalledWith("site_1", {
        name: "web",
      }),
    );
    expect(
      await screen.findByRole("heading", { name: "web" }),
    ).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("deletes from the drawer danger zone after a confirmation and returns to the project's sites", async () => {
    vi.mocked(mockApi.deleteSite).mockResolvedValue(undefined);
    open();
    await userEvent.click(await screen.findByRole("button", { name: "Edit" }));
    const drawer = await screen.findByRole("dialog");
    await userEvent.click(
      within(drawer).getByRole("button", { name: "Delete site" }),
    );
    const modal = (await screen.findByText("Delete site?")).closest(
      '[role="dialog"]',
    ) as HTMLElement;
    await userEvent.click(
      within(modal).getByRole("button", { name: "Delete site" }),
    );
    await waitFor(() =>
      expect(mockApi.deleteSite).toHaveBeenCalledWith("site_1"),
    );
    expect(await screen.findByText("project tab")).toBeInTheDocument();
  });

  it("hides the Domain field on an API without site names", async () => {
    open();
    const drawer = await openEdit();
    expect(within(drawer).queryByLabelText(/^Domain/)).toBeNull();
  });

  it("shows the Domain field with the host suffix and the move note", async () => {
    open(NAMED_API);
    const drawer = await openEdit();
    const field = within(drawer).getByLabelText(/^Domain/);
    expect(field).toHaveValue("");
    expect(field).toHaveAttribute("maxLength", "32");
    expect(within(drawer).getByText(".dev-g.yyt.life")).toBeInTheDocument();
    expect(
      within(drawer).getByText(/Also served at dev-g\.yyt\.life\/<name>\//),
    ).toBeInTheDocument();
    expect(
      within(drawer).getByText(/the old URLs stop working/),
    ).toBeInTheDocument();
    expect(
      within(drawer).getByText(
        /A name that has served files stays with this team/,
      ),
    ).toBeInTheDocument();
  });

  it("shows the path hint on a stage without the per-site host", async () => {
    open({ ...NAMED_API, hostUrl: null, hostSuffix: null });
    const drawer = await openEdit();
    expect(within(drawer).getByLabelText(/^Domain/)).toBeInTheDocument();
    expect(within(drawer).queryByText(".dev-g.yyt.life")).toBeNull();
    expect(
      within(drawer).getByText(/^Served at dev-g\.yyt\.life\/<name>\//),
    ).toBeInTheDocument();
  });

  it("disables the Domain field while the site is busy", async () => {
    open({ ...NAMED_API, busy: true });
    const drawer = await openEdit();
    expect(within(drawer).getByLabelText(/^Domain/)).toBeDisabled();
  });

  it("sends the domain only when it changed, lower-cased", async () => {
    vi.mocked(mockApi.updateSite).mockResolvedValue({
      ...NAMED_API,
      name: "web",
    });
    open(NAMED_API);
    let drawer = await openEdit();
    const name = within(drawer).getByLabelText(/^Name/);
    await userEvent.clear(name);
    await userEvent.type(name, "web");
    await userEvent.click(within(drawer).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(mockApi.updateSite).toHaveBeenCalledWith("site_1", {
        name: "web",
      }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    // An empty site is renamed at once (200): the new URLs come back.
    vi.mocked(mockApi.updateSite).mockResolvedValue(NAMED);
    vi.mocked(mockApi.site).mockResolvedValue(NAMED);
    drawer = await openEdit();
    await userEvent.type(within(drawer).getByLabelText(/^Domain/), "My-Game");
    expect(within(drawer).getByLabelText(/^Domain/)).toHaveValue("my-game");
    await userEvent.click(within(drawer).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(mockApi.updateSite).toHaveBeenLastCalledWith("site_1", {
        domain: "my-game",
      }),
    );
    expect(
      await screen.findByRole("link", {
        name: "https://my-game.dev-g.yyt.life/",
      }),
    ).toHaveAttribute("target", "_blank");
  });

  it("clears a claimed name with null", async () => {
    vi.mocked(mockApi.updateSite).mockResolvedValue(NAMED_API);
    open(NAMED);
    const drawer = await openEdit();
    const field = within(drawer).getByLabelText(/^Domain/);
    expect(field).toHaveValue("my-game");
    await userEvent.clear(field);
    await userEvent.click(within(drawer).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(mockApi.updateSite).toHaveBeenCalledWith("site_1", {
        domain: null,
      }),
    );
  });

  it("links the site host only for a named site and lists the other URL", async () => {
    open(NAMED);
    expect(
      await screen.findByRole("link", {
        name: "https://my-game.dev-g.yyt.life/",
      }),
    ).toBeInTheDocument();
    expect(screen.getByText("Path URL")).toBeInTheDocument();
    expect(
      screen.getByText("https://dev-g.yyt.life/my-game/"),
    ).toBeInTheDocument();
  });

  it("keeps the path URL primary for an unnamed site", async () => {
    open(NAMED_API);
    expect(
      await screen.findByRole("link", {
        name: "https://dev-g.yyt.life/abc123/",
      }),
    ).toBeInTheDocument();
    expect(screen.getByText("Site host")).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "https://abc123.dev-g.yyt.life/" }),
    ).toBeNull();
    // A relative base works on both; `/` only on the site host.
    expect(screen.getByText(/works only on the site host/)).toBeInTheDocument();
  });

  it("shows a queued move (202) as moving and blocks deploys until it settles", async () => {
    const moving: SiteDetail = {
      ...NAMED_API,
      busy: true,
      movingTo: "my-game",
      deploys: [
        {
          ...SITE.deploys[0]!,
          id: "dep_2",
          status: "queued",
          kind: "move",
          moveTo: "my-game",
          moveFrom: "abc123",
        },
        ...SITE.deploys,
      ],
    };
    vi.mocked(mockApi.updateSite).mockResolvedValue({
      ...NAMED_API,
      busy: true,
      movingTo: "my-game",
    });
    open(NAMED_API);
    const drawer = await openEdit();
    vi.mocked(mockApi.site).mockResolvedValue(moving);
    await userEvent.type(within(drawer).getByLabelText(/^Domain/), "my-game");
    await userEvent.click(within(drawer).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(
      await screen.findByText(/the files are being copied/),
    ).toBeInTheDocument();
    expect(screen.getByText("moving")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "A move is in flight" }),
    ).toBeDisabled();
    const kind = async (id: string) =>
      within((await screen.findByText(id)).closest("tr")!).getAllByRole(
        "cell",
      )[1]!.textContent;
    expect(await kind("dep_2")).toBe("move → my-game");
    expect(await kind("dep_1")).toBe("upload");
    expect(
      screen.getByRole("columnheader", { name: "Kind" }),
    ).toBeInTheDocument();
  });

  it("clips a long move target to one line and unfolds it on a tap", async () => {
    const long = "a-very-long-name-for-a-game-site";
    open({
      ...NAMED,
      deploys: [
        {
          ...SITE.deploys[0]!,
          id: "dep_9",
          kind: "move",
          moveTo: long,
          moveFrom: "abc123",
        },
      ],
    });
    const button = await screen.findByRole("button", { name: long });
    expect(button).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(button);
    expect(button).toHaveAttribute("aria-expanded", "true");
    const fold = await screen.findByRole("group", {
      name: "Move target of dep_9",
    });
    expect(fold).toHaveTextContent(long);
    expect(button).toHaveAttribute("aria-controls", fold.id);
  });

  it.each([
    [
      apiError(409, "this name is taken", { reason: "domain_taken" }),
      /This name is taken/,
    ],
    [
      apiError(409, "too many site names", {
        reason: "domain_cap",
        names: [
          { name: "one", releasedAt: null },
          { name: "two", releasedAt: 1 },
        ],
      }),
      /limit of names.*\(one, two\)/,
    ],
    [
      apiError(409, "cleaning", { reason: "domain_cleaning" }),
      /still being cleaned up/,
    ],
    [
      apiError(429, "one site name request per team per second", {
        retryAfterMs: 1000,
      }),
      /try again in 1 s/,
    ],
    [
      apiError(400, "invalid body", [
        { path: "domain", message: "this name is reserved" },
      ]),
      /^This name is reserved\.$/,
    ],
  ])("shows a refused name inline under the field (%#)", async (err, text) => {
    vi.mocked(mockApi.updateSite).mockRejectedValue(err);
    open(NAMED_API);
    const drawer = await openEdit();
    const field = within(drawer).getByLabelText(/^Domain/);
    await userEvent.type(field, "taken");
    await userEvent.click(within(drawer).getByRole("button", { name: "Save" }));
    expect(await within(drawer).findByText(text)).toBeInTheDocument();
    expect(field).toHaveAttribute("aria-invalid", "true");
    // Still open, and the general error notice stays empty.
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(within(drawer).queryByRole("alert")).toBeNull();
    // Typing again clears it.
    await userEvent.type(field, "x");
    expect(within(drawer).queryByText(text)).toBeNull();
  });

  it("keeps a busy site's 409 in the drawer notice", async () => {
    vi.mocked(mockApi.updateSite).mockRejectedValue(
      apiError(409, "a deploy is in flight; retry later"),
    );
    open(NAMED_API);
    const drawer = await openEdit();
    await userEvent.type(within(drawer).getByLabelText(/^Domain/), "free");
    await userEvent.click(within(drawer).getByRole("button", { name: "Save" }));
    expect(
      await within(drawer).findByText("a deploy is in flight; retry later"),
    ).toBeInTheDocument();
  });

  it("does not undo a move that lands while the drawer is open", async () => {
    const { user, poll } = pollClock();
    vi.mocked(mockApi.updateSite).mockResolvedValue({
      ...NAMED,
      description: "new",
    });
    open(MOVING);
    await user.click(await screen.findByRole("button", { name: "Edit" }));
    const drawer = await screen.findByRole("dialog");
    const field = within(drawer).getByLabelText(/^Domain/);
    expect(field).toBeDisabled();
    expect(field).toHaveValue("");
    // The move lands; the next poll brings the claimed name.
    vi.mocked(mockApi.site).mockResolvedValue(NAMED);
    await poll();
    await waitFor(() => expect(field).toHaveValue("my-game"));
    expect(field).toBeEnabled();
    const desc = within(drawer).getByLabelText(/^Description/);
    await user.clear(desc);
    await user.type(desc, "new");
    await user.click(within(drawer).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mockApi.updateSite).toHaveBeenCalledTimes(1));
    const [, body] = vi.mocked(mockApi.updateSite).mock.calls[0]!;
    expect(body).toEqual({ description: "new" });
    expect("domain" in body).toBe(false);
  });

  it("holds a typed domain change once the site turns busy", async () => {
    const { user, poll } = pollClock();
    // A deploy just queued: polled, but the site is not held yet.
    const queued: SiteDetail = {
      ...NAMED_API,
      deploys: [{ ...SITE.deploys[0]!, id: "dep_2", status: "queued" }],
    };
    open(queued);
    await user.click(await screen.findByRole("button", { name: "Edit" }));
    const drawer = await screen.findByRole("dialog");
    const field = within(drawer).getByLabelText(/^Domain/);
    await user.type(field, "my-game");
    const save = within(drawer).getByRole("button", { name: "Save" });
    expect(save).toBeEnabled();
    vi.mocked(mockApi.site).mockResolvedValue({ ...queued, busy: true });
    await poll();
    await waitFor(() => expect(field).toBeDisabled());
    // A 409 would still spend the team's one-per-second slot.
    expect(save).toBeDisabled();
    expect(
      within(drawer).getByText(/the domain can change once it settles/),
    ).toBeInTheDocument();
    // Once the site settles the typed change can be saved again.
    vi.mocked(mockApi.site).mockResolvedValue(queued);
    await poll();
    await waitFor(() => expect(field).toBeEnabled());
    expect(save).toBeEnabled();
    expect(mockApi.updateSite).not.toHaveBeenCalled();
  });

  it("keeps polling a busy site after a failed poll", async () => {
    const { poll } = pollClock();
    open(MOVING);
    expect(await screen.findByText("moving")).toBeInTheDocument();
    vi.mocked(mockApi.site).mockRejectedValueOnce(
      apiError(503, "service unavailable"),
    );
    await poll();
    expect(
      await screen.findByText(
        /Could not refresh the site: service unavailable/,
      ),
    ).toBeInTheDocument();
    // The page stays; only the notice says the read failed.
    expect(
      screen.getByRole("heading", { name: "game-web" }),
    ).toBeInTheDocument();
    expect(screen.getByText("moving")).toBeInTheDocument();
    vi.mocked(mockApi.site).mockResolvedValue(NAMED);
    await poll();
    await waitFor(() => expect(screen.queryByText("moving")).toBeNull());
    expect(screen.queryByText(/Could not refresh/)).toBeNull();
  });

  it("stops polling a busy site that is gone", async () => {
    const { poll } = pollClock();
    open(MOVING);
    expect(await screen.findByText("moving")).toBeInTheDocument();
    vi.mocked(mockApi.site).mockRejectedValue(apiError(404, "site not found"));
    await poll();
    expect(await screen.findByText("site not found")).toBeInTheDocument();
    const calls = vi.mocked(mockApi.site).mock.calls.length;
    await poll();
    await poll();
    expect(vi.mocked(mockApi.site).mock.calls.length).toBe(calls);
  });

  it("shows a name and a domain refusal from one 400 under both fields", async () => {
    vi.mocked(mockApi.updateSite).mockRejectedValue(
      apiError(400, "invalid body", [
        { path: "name", message: "names must not look like an id" },
        { path: "domain", message: "this name is reserved" },
      ]),
    );
    open(NAMED_API);
    const drawer = await openEdit();
    const name = within(drawer).getByLabelText(/^Name/);
    await userEvent.clear(name);
    await userEvent.type(name, "st_web");
    const domain = within(drawer).getByLabelText(/^Domain/);
    await userEvent.type(domain, "admin");
    await userEvent.click(within(drawer).getByRole("button", { name: "Save" }));
    expect(
      await within(drawer).findByText("Names must not look like an id."),
    ).toBeInTheDocument();
    expect(
      within(drawer).getByText("This name is reserved."),
    ).toBeInTheDocument();
    expect(name).toHaveAttribute("aria-invalid", "true");
    expect(domain).toHaveAttribute("aria-invalid", "true");
    expect(within(drawer).queryByRole("alert")).toBeNull();
    // Editing one field clears only its own error.
    await userEvent.type(name, "x");
    expect(
      within(drawer).queryByText("Names must not look like an id."),
    ).toBeNull();
    expect(
      within(drawer).getByText("This name is reserved."),
    ).toBeInTheDocument();
  });

  it("is read-only for a seatless admin", async () => {
    vi.mocked(mockApi.team).mockResolvedValue({ ...TEAM, role: "admin" });
    open();
    await screen.findByRole("heading", { name: "game-web" });
    expect(await screen.findByText(/Read-only/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Deploy" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.queryByRole("button", { name: "More actions" })).toBeNull();
  });
});
