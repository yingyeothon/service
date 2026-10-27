import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../src/api";
import type {
  CatalogApp,
  CreatedShareLink,
  ShareLink,
  ShareLinkList,
} from "../src/types";

const mockApi = {
  shareLinks: vi.fn(),
  createShareLink: vi.fn(),
  revokeShareLink: vi.fn(),
} as unknown as ApiClient;

vi.mock("../src/api", () => ({
  api: mockApi,
  ApiError: class extends Error {},
}));
const { qrLoaded } = vi.hoisted(() => ({ qrLoaded: vi.fn() }));
vi.mock("qrcode", () => {
  qrLoaded();
  return {
    default: { toDataURL: vi.fn(async () => "data:image/png;base64,QQ==") },
  };
});

const { ShareModal } = await import("../src/components/ShareModal");
const { mount } = await import("./wrap");

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
const NOW = Math.floor(Date.now() / 1000);
const LIVE: ShareLink = {
  id: "shl_1",
  label: "for bob",
  createdBy: "alice",
  createdAt: NOW - 60,
  expiresAt: NOW + 86_400,
  revokedAt: null,
  live: true,
};
const REVOKED: ShareLink = {
  ...LIVE,
  id: "shl_2",
  label: "old one",
  revokedAt: NOW - 30,
  live: false,
};
const EXPIRED: ShareLink = {
  ...LIVE,
  id: "shl_3",
  label: "stale",
  expiresAt: NOW - 30,
  live: false,
};
const TOKEN_URL =
  "https://console.example/i/shr_0123456789abcdef0123456789abcdef";

function list(over: Partial<ShareLinkList> = {}): ShareLinkList {
  return {
    links: [LIVE, REVOKED, EXPIRED],
    publicUrl: null,
    limit: 20,
    ...over,
  };
}

function open(canWrite = true) {
  return mount(
    <ShareModal
      app={APP}
      opened
      onClose={() => undefined}
      canWrite={canWrite}
    />,
    { client: mockApi, auth: false },
  );
}

describe("ShareModal", () => {
  const shareDescriptor = Object.getOwnPropertyDescriptor(navigator, "share");
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(mockApi.shareLinks).mockResolvedValue(list());
  });
  afterEach(() => {
    if (shareDescriptor)
      Object.defineProperty(navigator, "share", shareDescriptor);
    else Reflect.deleteProperty(navigator, "share");
  });

  it("lists the links with their status and no public link while unlisted", async () => {
    open();
    const dialog = await screen.findByRole("dialog", { name: "Share my-game" });
    const live = (await within(dialog).findByText("for bob")).closest("tr")!;
    for (const c of ["Label", "Created by", "Expires", "Status"])
      expect(
        within(dialog).getByRole("columnheader", { name: c }),
      ).toBeInTheDocument();
    expect(within(live).getByText("live")).toBeInTheDocument();
    expect(
      within(within(dialog).getByText("old one").closest("tr")!).getByText(
        "revoked",
      ),
    ).toBeInTheDocument();
    expect(
      within(within(dialog).getByText("stale").closest("tr")!).getByText(
        "expired",
      ),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText(/Publish the app for everyone/),
    ).toBeInTheDocument();
    expect(
      within(dialog).queryByRole("button", { name: "Copy Public link" }),
    ).toBeNull();
    // Only a live link has a verb.
    expect(
      within(dialog).queryByRole("button", { name: "Actions for old one" }),
    ).toBeNull();
    expect(qrLoaded).not.toHaveBeenCalled();
  });

  it("shows the public link when the listing is public", async () => {
    vi.mocked(mockApi.shareLinks).mockResolvedValue(
      list({ publicUrl: "https://console.example/i/ca_1" }),
    );
    open();
    expect(
      await screen.findByText("https://console.example/i/ca_1"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Copy Public link" }),
    ).toBeInTheDocument();
    const x = screen.getByRole("link", { name: "Post on X" });
    expect(x).toHaveAttribute(
      "href",
      `https://x.com/intent/post?url=${encodeURIComponent("https://console.example/i/ca_1")}&text=${encodeURIComponent("Install my-game")}`,
    );
    expect(x).toHaveAttribute("target", "_blank");
    expect(x).toHaveAttribute("rel", "noopener noreferrer");
    expect(
      screen.getByRole("link", { name: "Send with LINE" }),
    ).toHaveAttribute(
      "href",
      `https://line.me/R/share?text=${encodeURIComponent("Install my-game https://console.example/i/ca_1")}`,
    );
    // No Web Share in jsdom: no button for it.
    expect(screen.queryByRole("button", { name: "Share…" })).toBeNull();
  });

  it("creates a link and shows its URL once, with a QR and Web Share", async () => {
    const share = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "share", {
      value: share,
      configurable: true,
    });
    const created: CreatedShareLink = {
      ...LIVE,
      id: "shl_9",
      label: "testers",
      url: TOKEN_URL,
    };
    vi.mocked(mockApi.createShareLink).mockResolvedValue(created);
    open();
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Expires in"), {
      target: { value: "30" },
    });
    await userEvent.type(within(dialog).getByLabelText("Label"), " testers ");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Create link" }),
    );
    await waitFor(() =>
      expect(mockApi.createShareLink).toHaveBeenCalledWith("ca_1", {
        expiresInDays: 30,
        label: "testers",
      }),
    );
    expect(await within(dialog).findByText(TOKEN_URL)).toBeInTheDocument();
    expect(within(dialog).getByText(/shown once/)).toBeInTheDocument();
    expect(
      await within(dialog).findByRole("img", {
        name: "QR code of the share link",
      }),
    ).toHaveAttribute("src", "data:image/png;base64,QQ==");
    // The list refetches after the create.
    await waitFor(() => expect(mockApi.shareLinks).toHaveBeenCalledTimes(2));
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Share…" }),
    );
    expect(share).toHaveBeenCalledWith({
      title: "my-game",
      text: "Install my-game",
      url: TOKEN_URL,
    });
    // Done forgets the URL; the form is back.
    await userEvent.click(within(dialog).getByRole("button", { name: "Done" }));
    expect(within(dialog).queryByText(TOKEN_URL)).toBeNull();
    expect(
      within(dialog).getByRole("button", { name: "Create link" }),
    ).toBeInTheDocument();
  });

  it("explains the live-link cap on a 409", async () => {
    vi.mocked(mockApi.createShareLink).mockRejectedValue(
      Object.assign(new Error("conflict"), {
        status: 409,
        details: { limit: 20, value: 20 },
      }),
    );
    open();
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText("for bob");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Create link" }),
    );
    expect(
      await within(dialog).findByText(
        "This app already has 20 live links. Revoke one first.",
      ),
    ).toBeInTheDocument();
    expect(mockApi.createShareLink).toHaveBeenCalledWith("ca_1", {
      expiresInDays: 7,
    });
  });

  it("revokes a live link after a confirm", async () => {
    vi.mocked(mockApi.revokeShareLink).mockResolvedValue(undefined);
    open();
    await userEvent.click(
      await screen.findByRole("button", { name: "Actions for for bob" }),
    );
    await userEvent.click(screen.getByRole("menuitem", { name: "Revoke" }));
    await userEvent.click(
      await screen.findByRole("button", { name: "Revoke link" }),
    );
    await waitFor(() =>
      expect(mockApi.revokeShareLink).toHaveBeenCalledWith("ca_1", "shl_1"),
    );
    await waitFor(() => expect(mockApi.shareLinks).toHaveBeenCalledTimes(2));
  });

  it("offers no create form or revoke to a reader", async () => {
    open(false);
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText("for bob");
    expect(
      within(dialog).queryByRole("button", { name: "Create link" }),
    ).toBeNull();
    expect(
      within(dialog).queryByRole("button", { name: "Actions for for bob" }),
    ).toBeNull();
  });
});
