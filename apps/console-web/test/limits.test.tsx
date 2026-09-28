import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../src/api";
import type {
  LimitRequest,
  LimitScopeKind,
  LimitsView,
  TeamStanding,
} from "../src/types";

const mockApi = {
  me: vi.fn(),
  logout: vi.fn(),
  loginUrl: vi.fn(() => "/auth/github/start"),
  setUnauthorizedHandler: vi.fn(),
  limits: vi.fn(),
  requestLimit: vi.fn(),
  cancelLimitRequest: vi.fn(),
  setLimitOverride: vi.fn(),
  revokeLimitOverride: vi.fn(),
} as unknown as ApiClient;

vi.mock("../src/api", () => ({
  api: mockApi,
  ApiError: class extends Error {},
}));

const { LimitsSection, useLimits } = await import("../src/components/Limits");
const { fmtTime } = await import("../src/lib/format");
const { mount } = await import("./wrap");

const MiB = 1024 * 1024;
const NO_EXPIRY = 253402300799;

const BUNDLE: LimitsView = {
  scope: { kind: "bundle", id: "ab_1" },
  teamId: "team_1",
  limits: [
    {
      key: "asset.fileBytes",
      unit: "bytes",
      soft: 2 * MiB,
      hard: 256 * MiB,
      effective: 8 * MiB,
      usage: 3 * MiB,
      override: {
        value: 8 * MiB,
        expiresAt: 1_900_000_000,
        note: "contest day",
        requestId: null,
        grantedBy: "u9",
        grantedByLogin: "boss",
        grantedAt: 1_800_000_000,
      },
    },
    {
      key: "asset.bundleBytes",
      unit: "bytes",
      soft: 20 * MiB,
      hard: 3072 * MiB,
      effective: 20 * MiB,
      usage: 25 * MiB,
      override: null,
    },
    {
      key: "asset.filesPerVersion",
      unit: "count",
      soft: 200,
      hard: 5000,
      effective: 200,
      usage: 12,
      override: null,
    },
  ],
  pending: [],
};

const request = (over: Partial<LimitRequest> = {}): LimitRequest => ({
  id: "lr_1",
  teamId: "team_1",
  teamName: "studio",
  scope: { kind: "bundle", id: "ab_1", name: "maps" },
  key: "asset.filesPerVersion",
  unit: "count",
  hard: 5000,
  requestedValue: 1000,
  reason: "big level",
  status: "pending",
  decidedValue: null,
  decisionNote: null,
  createdBy: "u1",
  createdByLogin: "alice",
  createdAt: Math.floor(Date.now() / 1000) - 3600,
  decidedBy: null,
  decidedByLogin: null,
  decidedAt: null,
  ...over,
});

const CHANNEL = (expiresAt: number, raised = false): LimitsView => ({
  scope: { kind: "channel", id: "auth_1" },
  teamId: "team_1",
  expiresAt,
  limits: [
    {
      key: "channel.lifetime",
      unit: "seconds",
      soft: 2419200,
      hard: "unlimited",
      effective: raised ? "unlimited" : 2419200,
      usage: null,
      override: raised
        ? {
            value: "unlimited",
            expiresAt: null,
            note: "long event",
            requestId: "lr_2",
            grantedBy: "u9",
            grantedByLogin: "boss",
            grantedAt: 0,
          }
        : null,
    },
  ],
  pending: [],
});

const onChanged = vi.fn(() => Promise.resolve());

function Harness({
  kind,
  id,
  standing,
}: {
  kind: LimitScopeKind;
  id: string;
  standing: TeamStanding | undefined;
}) {
  const limits = useLimits(kind, id);
  return (
    <LimitsSection limits={limits} standing={standing} onChanged={onChanged} />
  );
}

function open(view: LimitsView, standing: TeamStanding | undefined = "member") {
  vi.mocked(mockApi.limits).mockResolvedValue(view);
  return mount(
    <Harness kind={view.scope.kind} id={view.scope.id} standing={standing} />,
    { client: mockApi },
  );
}

const asAdmin = () =>
  vi.mocked(mockApi.me).mockResolvedValue({
    id: "u9",
    login: "root",
    role: "admin",
    via: "session",
  });

async function section() {
  const h = await screen.findByRole("heading", { name: "Limits" });
  return h.closest("section")!;
}

describe("LimitsSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(mockApi.me).mockResolvedValue({
      id: "u1",
      login: "alice",
      role: "member",
      via: "session",
    });
  });

  it("lists every key with usage, the effective value and the ceiling", async () => {
    open(BUNDLE);
    const s = await section();
    expect(await within(s).findByText("File size")).toBeInTheDocument();
    expect(mockApi.limits).toHaveBeenCalledWith("bundle:ab_1");
    for (const col of ["Limit", "Usage", "Effective", "Ceiling"])
      expect(
        within(s).getByRole("columnheader", { name: col }),
      ).toBeInTheDocument();
    const row = (label: string) =>
      within(s).getByText(label).closest("tr") as HTMLElement;
    expect(within(row("File size")).getByText("3 MiB")).toBeInTheDocument();
    expect(within(row("File size")).getByText("256 MiB")).toBeInTheDocument();
    // Raised: a real button with its expiry beside it, the note in a fold.
    const raised = within(row("File size")).getByRole("button", {
      name: "raised File size: details",
    });
    expect(raised).toHaveAttribute("aria-expanded", "false");
    expect(
      within(row("File size")).getByText(/^until \d{4}-\d{2}-\d{2}$/),
    ).toBeInTheDocument();
    await userEvent.click(raised);
    expect(raised).toHaveAttribute("aria-expanded", "true");
    expect(
      await within(row("File size")).findByRole("group", {
        name: "File size override",
      }),
    ).toHaveTextContent(/Default 2 MiB .* by boss .* contest day/);
    // Usage above the effective value is marked, never hidden.
    expect(within(row("Bundle size")).getByText("over")).toBeInTheDocument();
    expect(
      within(row("Files per version")).getByText("5,000"),
    ).toBeInTheDocument();
  });

  it("asks for a byte limit in the unit the member picked", async () => {
    vi.mocked(mockApi.requestLimit).mockResolvedValue(
      request({
        key: "asset.bundleBytes",
        unit: "bytes",
        hard: 3 * 1024 * MiB,
        requestedValue: 1024 * MiB,
      }),
    );
    open(BUNDLE);
    const s = await section();
    await userEvent.click(
      await within(s).findByRole("button", { name: "Request increase" }),
    );
    const drawer = await screen.findByRole("dialog");
    const key = within(drawer).getByLabelText("Limit");
    expect(
      within(key)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["File size", "Bundle size", "Files per version"]);
    await userEvent.selectOptions(key, "asset.bundleBytes");
    const value = within(drawer).getByRole("textbox", { name: /^Value/ });
    await userEvent.type(value, "10");
    // Not more than the current 20 MiB: refused before it is sent.
    expect(
      await within(drawer).findByText("More than the current 20 MiB."),
    ).toBeInTheDocument();
    await userEvent.selectOptions(within(drawer).getByLabelText("Unit"), "GiB");
    await userEvent.clear(value);
    await userEvent.type(value, "1.5");
    await userEvent.type(
      within(drawer).getByLabelText(/^Reason/),
      "  a whole season of maps  ",
    );
    await userEvent.click(
      within(drawer).getByRole("button", { name: "Send request" }),
    );
    await waitFor(() =>
      expect(mockApi.requestLimit).toHaveBeenCalledWith({
        scope: "bundle:ab_1",
        key: "asset.bundleBytes",
        value: 1536 * MiB,
        reason: "a whole season of maps",
      }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(mockApi.limits).toHaveBeenCalledTimes(2);
  });

  it("asks for no expiry on a channel with no number to type", async () => {
    vi.mocked(mockApi.requestLimit).mockResolvedValue(
      request({
        key: "channel.lifetime",
        unit: "seconds",
        hard: "unlimited",
        requestedValue: "unlimited",
      }),
    );
    open(CHANNEL(Math.floor(Date.now() / 1000) + 86400));
    const s = await section();
    expect(await within(s).findByText("Lifetime")).toBeInTheDocument();
    expect(within(s).getByText("28 days")).toBeInTheDocument();
    expect(within(s).getByText("No expiry")).toBeInTheDocument();
    await userEvent.click(
      within(s).getByRole("button", { name: "Request increase" }),
    );
    const drawer = await screen.findByRole("dialog");
    expect(within(drawer).getByText("No expiry")).toBeInTheDocument();
    expect(
      within(drawer).queryByRole("textbox", { name: /^Value/ }),
    ).toBeNull();
    const send = within(drawer).getByRole("button", { name: "Send request" });
    expect(send).toBeDisabled();
    await userEvent.type(
      within(drawer).getByLabelText(/^Reason/),
      "hackathon week",
    );
    await userEvent.click(send);
    await waitFor(() =>
      expect(mockApi.requestLimit).toHaveBeenCalledWith({
        scope: "channel:auth_1",
        key: "channel.lifetime",
        value: "unlimited",
        reason: "hackathon week",
      }),
    );
  });

  it("says when the cooldown ends on a 429", async () => {
    const retryAt = 1_900_000_000;
    vi.mocked(mockApi.requestLimit).mockRejectedValue(
      Object.assign(new Error("rejected or cancelled recently"), {
        status: 429,
        details: { retryAt },
      }),
    );
    open(BUNDLE);
    const s = await section();
    await userEvent.click(
      await within(s).findByRole("button", { name: "Request increase" }),
    );
    const drawer = await screen.findByRole("dialog");
    await userEvent.selectOptions(
      within(drawer).getByLabelText("Limit"),
      "asset.filesPerVersion",
    );
    await userEvent.type(
      within(drawer).getByRole("textbox", { name: /^Value/ }),
      "1000",
    );
    await userEvent.type(within(drawer).getByLabelText(/^Reason/), "levels");
    await userEvent.click(
      within(drawer).getByRole("button", { name: "Send request" }),
    );
    expect(
      await within(drawer).findByText(
        `You can ask again on ${fmtTime(retryAt)}.`,
      ),
    ).toBeInTheDocument();
    // The drawer stays open with what was typed.
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("shows a 409 inline in the drawer", async () => {
    vi.mocked(mockApi.requestLimit).mockRejectedValue(
      Object.assign(
        new Error("the team already has 10 pending limit requests"),
        {
          status: 409,
        },
      ),
    );
    open(BUNDLE);
    const s = await section();
    await userEvent.click(
      await within(s).findByRole("button", { name: "Request increase" }),
    );
    const drawer = await screen.findByRole("dialog");
    await userEvent.selectOptions(
      within(drawer).getByLabelText("Limit"),
      "asset.filesPerVersion",
    );
    await userEvent.type(
      within(drawer).getByRole("textbox", { name: /^Value/ }),
      "300",
    );
    await userEvent.type(within(drawer).getByLabelText(/^Reason/), "more");
    await userEvent.click(
      within(drawer).getByRole("button", { name: "Send request" }),
    );
    expect(
      await within(drawer).findByText(
        "the team already has 10 pending limit requests",
      ),
    ).toBeInTheDocument();
  });

  it("offers no request to a seatless admin or to a channel with no expiry", async () => {
    open(BUNDLE, "admin");
    const s = await section();
    expect(await within(s).findByText("File size")).toBeInTheDocument();
    expect(
      within(s).queryByRole("button", { name: "Request increase" }),
    ).toBeNull();
  });

  it("hides the lifetime request once the channel has no expiry", async () => {
    open(CHANNEL(NO_EXPIRY, true));
    const s = await section();
    expect(await within(s).findByText("Lifetime")).toBeInTheDocument();
    expect(
      within(s).getByRole("button", { name: "raised Lifetime: details" }),
    ).toBeInTheDocument();
    expect(
      within(s).queryByRole("button", { name: "Request increase" }),
    ).toBeNull();
  });

  it("lists the scope's pending request and lets its requester cancel it", async () => {
    vi.mocked(mockApi.cancelLimitRequest).mockResolvedValue(
      request({ status: "cancelled" }),
    );
    open({ ...BUNDLE, pending: [request()] });
    const s = await section();
    expect(await within(s).findByText("Pending requests")).toBeInTheDocument();
    expect(within(s).getByText("1,000")).toBeInTheDocument();
    expect(within(s).getByText("alice")).toBeInTheDocument();
    await userEvent.click(
      within(s).getByRole("button", {
        name: "Actions for Files per version request",
      }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Cancel request" }),
    );
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Cancel request" }),
    );
    await waitFor(() =>
      expect(mockApi.cancelLimitRequest).toHaveBeenCalledWith("lr_1"),
    );
    // A pending key is not offered again.
    await userEvent.click(
      within(s).getByRole("button", { name: "Request increase" }),
    );
    const drawer = await screen.findByRole("dialog");
    expect(
      within(within(drawer).getByLabelText("Limit"))
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["File size", "Bundle size"]);
  });

  it("offers no cancel on someone else's request to a plain member, only its details", async () => {
    open({
      ...BUNDLE,
      pending: [request({ createdBy: "u2", createdByLogin: "bob" })],
    });
    const s = await section();
    expect(await within(s).findByText("bob")).toBeInTheDocument();
    await userEvent.click(
      within(s).getByRole("button", {
        name: "Actions for Files per version request",
      }),
    );
    expect(
      await screen.findByRole("menuitem", { name: "Details" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("menuitem", { name: "Cancel request" }),
    ).toBeNull();
    await userEvent.click(screen.getByRole("menuitem", { name: "Details" }));
    const details = await screen.findByRole("dialog");
    expect(within(details).getByText("big level")).toBeInTheDocument();
    // A plain member has no override verbs on the limit rows.
    expect(
      within(s).queryByRole("button", { name: "Actions for File size" }),
    ).toBeNull();
  });

  it("lets a platform admin set a temporary byte override", async () => {
    asAdmin();
    vi.mocked(mockApi.setLimitOverride).mockResolvedValue({
      scope: { kind: "bundle", id: "ab_1" },
      key: "asset.fileBytes",
      effective: 64 * MiB,
      override: null,
    });
    // Seatless: the override is the platform's, not a team write.
    open(BUNDLE, "admin");
    const s = await section();
    expect(
      within(s).queryByRole("button", { name: "Request increase" }),
    ).toBeNull();
    await userEvent.click(
      await within(s).findByRole("button", { name: "Actions for File size" }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Set limit" }),
    );
    const drawer = await screen.findByRole("dialog");
    const value = within(drawer).getByRole("textbox", { name: /^Value/ });
    // Opens on the effective value.
    expect(value).toHaveValue("8");
    expect(within(drawer).getByLabelText("Unit")).toHaveValue("MiB");
    await userEvent.clear(value);
    await userEvent.type(value, "512");
    expect(within(drawer).getByText("At most 256 MiB.")).toBeInTheDocument();
    const set = within(drawer).getByRole("button", { name: "Set limit" });
    expect(set).toBeDisabled();
    await userEvent.clear(value);
    await userEvent.type(value, "64");
    await userEvent.type(
      within(drawer).getByRole("textbox", { name: /^Temporary/ }),
      "3",
    );
    await userEvent.type(within(drawer).getByLabelText(/^Note/), " contest ");
    const before = Math.floor(Date.now() / 1000);
    await userEvent.click(set);
    await waitFor(() => expect(mockApi.setLimitOverride).toHaveBeenCalled());
    const after = Math.floor(Date.now() / 1000);
    const [kind, id, key, body] = vi.mocked(mockApi.setLimitOverride).mock
      .calls[0]!;
    expect([kind, id, key]).toEqual(["bundle", "ab_1", "asset.fileBytes"]);
    expect(body).toMatchObject({ value: 64 * MiB, note: "contest" });
    expect(body.expiresAt).toBeGreaterThanOrEqual(before + 3 * 86400);
    expect(body.expiresAt).toBeLessThanOrEqual(after + 3 * 86400);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(onChanged).toHaveBeenCalled();
    expect(mockApi.limits).toHaveBeenCalledTimes(2);
  });

  it("sets no expiry on a channel with nothing to type and no end date", async () => {
    asAdmin();
    vi.mocked(mockApi.setLimitOverride).mockResolvedValue({
      scope: { kind: "channel", id: "auth_1" },
      key: "channel.lifetime",
      effective: "unlimited",
      override: null,
    });
    open(CHANNEL(Math.floor(Date.now() / 1000) + 86400), "member");
    const s = await section();
    await userEvent.click(
      await within(s).findByRole("button", { name: "Actions for Lifetime" }),
    );
    // Nothing to revoke without an override.
    expect(
      await screen.findByRole("menuitem", { name: "Set limit" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("menuitem", { name: "Revoke override" }),
    ).toBeNull();
    await userEvent.click(screen.getByRole("menuitem", { name: "Set limit" }));
    const drawer = await screen.findByRole("dialog");
    expect(
      within(drawer).queryByRole("textbox", { name: /^Value/ }),
    ).toBeNull();
    expect(
      within(drawer).queryByRole("textbox", { name: /^Temporary/ }),
    ).toBeNull();
    const set = within(drawer).getByRole("button", { name: "Set limit" });
    expect(set).toBeDisabled();
    await userEvent.type(within(drawer).getByLabelText(/^Note/), "event");
    await userEvent.click(set);
    await waitFor(() =>
      expect(mockApi.setLimitOverride).toHaveBeenCalledWith(
        "channel",
        "auth_1",
        "channel.lifetime",
        { value: "unlimited", note: "event" },
      ),
    );
  });

  it("revokes an override with the reason as its note", async () => {
    asAdmin();
    vi.mocked(mockApi.revokeLimitOverride).mockResolvedValue(undefined);
    open(CHANNEL(NO_EXPIRY, true), "admin");
    const s = await section();
    await userEvent.click(
      await within(s).findByRole("button", { name: "Actions for Lifetime" }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Revoke override" }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/28 days from now/)).toBeInTheDocument();
    const revoke = within(dialog).getByRole("button", {
      name: "Revoke override",
    });
    expect(revoke).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText("Reason"), "event over");
    await userEvent.click(revoke);
    await waitFor(() =>
      expect(mockApi.revokeLimitOverride).toHaveBeenCalledWith(
        "channel",
        "auth_1",
        "channel.lifetime",
        "event over",
      ),
    );
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });
});
