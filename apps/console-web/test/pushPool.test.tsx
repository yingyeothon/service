import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../src/api";
import type { PushPoolSlot, PushPoolView } from "../src/types";

const mockApi = {
  me: vi.fn(),
  logout: vi.fn(),
  loginUrl: vi.fn(() => "/auth/github/start"),
  setUnauthorizedHandler: vi.fn(),
  pushPool: vi.fn(),
  setPushSlotClosed: vi.fn(),
} as unknown as ApiClient;

vi.mock("../src/api", () => ({
  api: mockApi,
  ApiError: class extends Error {},
}));

const { PushPoolPage } = await import("../src/pages/PushPool");
const { mount } = await import("./wrap");

const now = Math.floor(Date.now() / 1000);

const slot = (over: Partial<PushPoolSlot> = {}): PushPoolSlot => ({
  slot: "p1",
  provisioned: true,
  closed: false,
  closedBy: null,
  closedByLogin: null,
  closedAt: null,
  apps: 3,
  capacity: 20,
  ...over,
});
const pool = (slots: PushPoolSlot[], configured = true): PushPoolView => ({
  configured,
  slots,
});

const row = async (label: string) =>
  (await screen.findByText(label)).closest("tr")!;

async function rowAction(label: string, verb: string) {
  await userEvent.click(
    await screen.findByRole("button", { name: `Actions for slot ${label}` }),
  );
  await userEvent.click(await screen.findByRole("menuitem", { name: verb }));
}

describe("PushPoolPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(mockApi.me).mockResolvedValue({
      id: "u1",
      login: "root",
      role: "admin",
      via: "session",
    });
  });

  it("lists every slot with its apps, state and who closed it", async () => {
    vi.mocked(mockApi.pushPool).mockResolvedValue(
      pool([
        slot(),
        slot({
          slot: "p2",
          apps: 20,
          closed: true,
          closedBy: "u1",
          closedByLogin: "root",
          closedAt: now - 7200,
        }),
        slot({
          slot: "p3",
          apps: 20,
          closed: true,
          closedBy: "auto:firebase-limit",
          closedAt: now - 60,
        }),
        slot({ slot: "p4", apps: 20 }),
        slot({ slot: "old", provisioned: false, apps: 2 }),
      ]),
    );
    mount(<PushPoolPage />, { client: mockApi });
    expect(
      await screen.findByRole("heading", { name: "Push pool" }),
    ).toBeInTheDocument();
    const p1 = await row("p1");
    expect(
      screen
        .getAllByRole("columnheader")
        .map((h) => h.textContent)
        .filter(Boolean),
    ).toEqual(["Slot", "Apps", "State", "Closed by", "Closed", "Actions"]);

    expect(p1).toHaveTextContent("3 / 20");
    expect(within(p1).getByText("open")).toBeInTheDocument();

    const p2 = await row("p2");
    expect(within(p2).getByText("closed")).toBeInTheDocument();
    expect(p2).toHaveTextContent("root");
    expect(p2).toHaveTextContent("2h ago");

    expect(await row("p3")).toHaveTextContent("platform (app limit)");
    expect(within(await row("p4")).getByText("full")).toBeInTheDocument();

    // Not provisioned replaces the state badge; the row keeps its numbers.
    const old = await row("old");
    expect(within(old).getByText("not provisioned")).toBeInTheDocument();
    expect(within(old).queryByText("open")).toBeNull();
    expect(old).toHaveTextContent("2 / 20");
    expect(
      screen.getByText(/A slot that is not provisioned still has channels/),
    ).toBeInTheDocument();
    // Open, provisioned slots only: p1 (17 free) and the full p4.
    expect(
      screen.getByText("2 open slots · 17 registrations free"),
    ).toBeInTheDocument();
  });

  it("clips a long slot label and a long login to one line with a fold", async () => {
    const login = "a-github-login-at-the-39-character-cap0";
    vi.mocked(mockApi.pushPool).mockResolvedValue(
      pool([
        slot({
          slot: "contest-2026-autumn-overflow-03",
          closed: true,
          closedBy: "u7",
          closedByLogin: login,
          closedAt: now - 60,
        }),
      ]),
    );
    mount(<PushPoolPage />, { client: mockApi });
    // Each is a real disclosure button; the fold carries the whole value.
    const label = await screen.findByRole("button", {
      name: "contest-2026-autumn-overflow-03",
    });
    expect(label).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(label);
    expect(label).toHaveAttribute("aria-expanded", "true");
    expect(
      await screen.findByRole("group", {
        name: "Full label of slot contest-2026-autumn-overflow-03",
      }),
    ).toHaveTextContent("contest-2026-autumn-overflow-03");
    expect(screen.getByRole("button", { name: login })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("says push is not configured instead of an empty table", async () => {
    vi.mocked(mockApi.pushPool).mockResolvedValue(pool([], false));
    mount(<PushPoolPage />, { client: mockApi });
    expect(
      await screen.findByText(/Push is not configured on this stage/),
    ).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("still lists stray slots on an unconfigured stage", async () => {
    vi.mocked(mockApi.pushPool).mockResolvedValue(
      pool([slot({ slot: "old", provisioned: false })], false),
    );
    mount(<PushPoolPage />, { client: mockApi });
    expect(
      await screen.findByText(/Push is not configured on this stage/),
    ).toBeInTheDocument();
    expect(await row("old")).toHaveTextContent("not provisioned");
  });

  it("closes a slot after a confirm and reloads", async () => {
    vi.mocked(mockApi.pushPool).mockResolvedValue(pool([slot()]));
    vi.mocked(mockApi.setPushSlotClosed).mockResolvedValue({
      slot: "p1",
      closed: true,
      changed: true,
    });
    mount(<PushPoolPage />, { client: mockApi });
    await rowAction("p1", "Close slot");
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Close slot p1?");
    expect(dialog).toHaveTextContent(/Its channels keep working/);
    expect(mockApi.setPushSlotClosed).not.toHaveBeenCalled();
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Close slot" }),
    );
    await waitFor(() =>
      expect(mockApi.setPushSlotClosed).toHaveBeenCalledWith("p1", true),
    );
    expect(await screen.findByText("Slot p1 closed")).toBeInTheDocument();
    await waitFor(() => expect(mockApi.pushPool).toHaveBeenCalledTimes(2));
  });

  it("opens a closed slot, and says when nothing changed", async () => {
    vi.mocked(mockApi.pushPool).mockResolvedValue(
      pool([slot({ closed: true, closedBy: "u1", closedAt: now - 60 })]),
    );
    vi.mocked(mockApi.setPushSlotClosed).mockResolvedValue({
      slot: "p1",
      closed: false,
      changed: false,
    });
    mount(<PushPoolPage />, { client: mockApi });
    await rowAction("p1", "Open slot");
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent(/may register in it again/);
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Open slot" }),
    );
    await waitFor(() =>
      expect(mockApi.setPushSlotClosed).toHaveBeenCalledWith("p1", false),
    );
    expect(
      await screen.findByText("Slot p1 was already open"),
    ).toBeInTheDocument();
  });

  it("takes an automatic closure over, and says the slot stays closed", async () => {
    vi.mocked(mockApi.pushPool).mockResolvedValue(
      pool([
        slot({
          closed: true,
          closedBy: "auto:firebase-limit",
          closedAt: now - 60,
        }),
      ]),
    );
    // The server answers a takeover as a change: `closedBy` moved.
    vi.mocked(mockApi.setPushSlotClosed).mockResolvedValue({
      slot: "p1",
      closed: true,
      changed: true,
    });
    mount(<PushPoolPage />, { client: mockApi });
    await rowAction("p1", "Keep closed");
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent(/daily sweep reopens it/);
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Keep closed" }),
    );
    await waitFor(() =>
      expect(mockApi.setPushSlotClosed).toHaveBeenCalledWith("p1", true),
    );
    expect(
      await screen.findByText("Slot p1 stays closed until you open it"),
    ).toBeInTheDocument();
  });

  it("offers no takeover on a slot an admin closed", async () => {
    vi.mocked(mockApi.pushPool).mockResolvedValue(
      pool([slot({ closed: true, closedBy: "u1", closedAt: now - 60 })]),
    );
    mount(<PushPoolPage />, { client: mockApi });
    await userEvent.click(
      await screen.findByRole("button", { name: "Actions for slot p1" }),
    );
    expect(
      await screen.findByRole("menuitem", { name: "Open slot" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Keep closed" })).toBeNull();
  });

  it("shows a refused action inline", async () => {
    vi.mocked(mockApi.pushPool).mockResolvedValue(pool([slot()]));
    vi.mocked(mockApi.setPushSlotClosed).mockRejectedValue(
      new Error("push not configured"),
    );
    mount(<PushPoolPage />, { client: mockApi });
    await rowAction("p1", "Close slot");
    await userEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "Close slot",
      }),
    );
    expect(
      (await screen.findByText("push not configured")).closest(
        '[role="alert"]',
      ),
    ).not.toBeNull();
  });
});
