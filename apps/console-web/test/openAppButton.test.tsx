import { MantineProvider } from "@mantine/core";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const createAppHandoff = vi.fn();
vi.mock("../src/api", () => ({ api: { createAppHandoff } }));
let role = "member";
vi.mock("../src/auth", () => ({
  useAuth: () => ({ me: { id: "m1", login: "alice", role }, loading: false }),
}));

const { OpenAppButton } = await import("../src/components/OpenAppButton");
const { theme } = await import("../src/theme");

const ANDROID = { userAgent: "Mozilla/5.0 (Linux; Android 14) Chrome/128.0" };
const IOS = { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Safari" };
const CODE = "hoff_" + "cd".repeat(16);

function mount(nav: Partial<Navigator>, go = vi.fn(), host?: string) {
  render(
    <MantineProvider theme={theme} forceColorScheme="light">
      <OpenAppButton nav={nav} go={go} host={host} />
    </MantineProvider>,
  );
  return go;
}

describe("OpenAppButton", () => {
  it("renders only on Android and only for approved members", () => {
    mount(IOS);
    expect(screen.queryByRole("button", { name: "Open app" })).toBeNull();
    role = "pending";
    mount(ANDROID);
    expect(screen.queryByRole("button", { name: "Open app" })).toBeNull();
    role = "member";
    mount(ANDROID);
    expect(screen.getByRole("button", { name: "Open app" })).toBeTruthy();
  });

  it("mints a code, navigates to the intent URL, and never shows the code", async () => {
    createAppHandoff.mockResolvedValue({ code: CODE, expiresInSec: 120 });
    const go = mount(ANDROID);
    await userEvent.click(screen.getByRole("button", { name: "Open app" }));
    await waitFor(() => expect(go).toHaveBeenCalledTimes(1));
    const url = go.mock.calls[0]![0] as string;
    expect(url).toMatch(/^intent:\/\/localhost(:\d+)?\/app-open\?code=hoff_/);
    expect(url).toContain(CODE);
    expect(url).toContain("package=life.yyt.console");
    // The retry anchor carries the same intent URL as an href, not as text.
    const retry = screen.getByRole("link", { name: "open the app again" });
    expect(retry.getAttribute("href")).toBe(url);
    expect(document.body.textContent).not.toContain(CODE);
  });

  it("shows the API error and does not navigate", async () => {
    createAppHandoff.mockRejectedValue(new Error("too many tokens (max 20)"));
    const go = mount(ANDROID);
    await userEvent.click(screen.getByRole("button", { name: "Open app" }));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain(
        "too many tokens",
      ),
    );
    expect(go).not.toHaveBeenCalled();
  });
});

describe("OpenAppButton on iOS", () => {
  const DEV = "console-dev.yyt.life";
  afterEach(() => {
    vi.useRealTimers();
    createAppHandoff.mockReset();
  });

  it("hides on a host without a link host and for pending members", () => {
    mount(IOS, vi.fn(), "localhost:5173");
    expect(screen.queryByRole("button", { name: "Open app" })).toBeNull();
    role = "pending";
    mount(IOS, vi.fn(), DEV);
    expect(screen.queryByRole("button", { name: "Open app" })).toBeNull();
    role = "member";
    mount(IOS, vi.fn(), DEV);
    expect(screen.getByRole("button", { name: "Open app" })).toBeTruthy();
  });

  it("mints on tap 1, then offers a real link-host anchor and never navigates", async () => {
    createAppHandoff.mockResolvedValue({
      code: CODE,
      expiresInSec: 120,
      linkHost: "link-dev.yyt.life",
    });
    const go = mount(IOS, vi.fn(), DEV);
    await userEvent.click(screen.getByRole("button", { name: "Open app" }));
    const link = await screen.findByRole("link", { name: "Open app" });
    expect(link.getAttribute("href")).toBe(
      `https://link-dev.yyt.life/app-open?code=${CODE}`,
    );
    expect(screen.queryByRole("button", { name: "Open app" })).toBeNull();
    expect(go).not.toHaveBeenCalled();
    expect(createAppHandoff).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).not.toContain(CODE);
    // Focus follows the button's replacement, and the hint is announced
    // once from a polite region that never holds the counter.
    expect(document.activeElement).toBe(link);
    const hint = screen.getByRole("status");
    expect(hint.getAttribute("aria-live")).toBe("polite");
    expect(hint.textContent).toContain("again to sign in");
    expect(hint.textContent).not.toMatch(/\d+ s/);
    // Long-press only re-enables the app; it never reuses this link.
    const text = document.body.textContent ?? "";
    expect(text).toContain("long-press");
    expect(text).toContain("Open in 잉여톤");
    expect(text).toContain("again for a fresh link");
    expect(text).toContain("open this page in Safari");
    expect(text).not.toMatch(/choose to open it in 잉여톤/);
  });

  it("refuses a server link host that does not match the console host", async () => {
    createAppHandoff.mockResolvedValue({
      code: CODE,
      expiresInSec: 120,
      linkHost: "link.yyt.life",
    });
    mount(IOS, vi.fn(), DEV);
    await userEvent.click(screen.getByRole("button", { name: "Open app" }));
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain(
        "does not support opening the iOS app",
      ),
    );
    expect(screen.queryByRole("link", { name: "Open app" })).toBeNull();
    expect(document.body.innerHTML).not.toContain(CODE);
  });

  it("drops the code and shows a notice when the server has no link host", async () => {
    createAppHandoff.mockResolvedValue({ code: CODE, expiresInSec: 120 });
    mount(IOS, vi.fn(), DEV);
    await userEvent.click(screen.getByRole("button", { name: "Open app" }));
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain(
        "does not support opening the iOS app",
      ),
    );
    expect(screen.queryByRole("link", { name: "Open app" })).toBeNull();
    expect(document.body.innerHTML).not.toContain(CODE);
    // No second mint from the same page.
    const button = screen.getByRole("button", { name: "Open app" });
    expect(button.hasAttribute("disabled")).toBe(true);
  });

  it("counts down and expires the link with the code", async () => {
    vi.useFakeTimers();
    createAppHandoff.mockResolvedValue({
      code: CODE,
      expiresInSec: 120,
      linkHost: "link-dev.yyt.life",
    });
    mount(IOS, vi.fn(), DEV);
    fireEvent.click(screen.getByRole("button", { name: "Open app" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByRole("link", { name: "Open app" })).toBeTruthy();
    // Right from the first frame, 3 s short of the server's lifetime.
    expect(document.body.textContent).toContain("valid for 117 s");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(57_000);
    });
    expect(document.body.textContent).toContain("valid for 60 s");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(59_000);
    });
    expect(screen.getByRole("link", { name: "Open app" })).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(screen.queryByRole("link", { name: "Open app" })).toBeNull();
    expect(document.body.innerHTML).not.toContain(CODE);
    expect(document.body.textContent).toContain("link expired");
    // A fresh tap mints a fresh code.
    expect(
      screen.getByRole("button", { name: "Open app" }).hasAttribute("disabled"),
    ).toBe(false);
  });

  describe("after tap 2", () => {
    // jsdom cannot navigate; stop the default action after React has seen
    // the click, and remember whether the component swallowed it.
    const swallowed: boolean[] = [];
    const stopNavigation = (e: Event) => {
      if (!(e.target as Element).closest("a")) return;
      swallowed.push(e.defaultPrevented);
      e.preventDefault();
    };
    beforeEach(() => {
      swallowed.length = 0;
      window.addEventListener("click", stopNavigation);
    });
    afterEach(() => {
      window.removeEventListener("click", stopNavigation);
      delete (document as { visibilityState?: unknown }).visibilityState;
    });

    async function tapTwice() {
      createAppHandoff.mockResolvedValue({
        code: CODE,
        expiresInSec: 120,
        linkHost: "link-dev.yyt.life",
      });
      mount(IOS, vi.fn(), DEV);
      fireEvent.click(screen.getByRole("button", { name: "Open app" }));
      await act(async () => {
        await Promise.resolve();
      });
      const link = await waitFor(() =>
        screen.getByRole("link", { name: "Open app" }),
      );
      fireEvent.click(link);
      return link;
    }

    it("drops the spent link when the page hides", async () => {
      await tapTwice();
      expect(swallowed).toEqual([false]);
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => "hidden",
      });
      act(() => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      expect(screen.queryByRole("link", { name: "Open app" })).toBeNull();
      expect(document.body.innerHTML).not.toContain(CODE);
      expect(screen.getByRole("status").textContent).toBe(
        "Tap Open app for a new link.",
      );
      expect(
        screen
          .getByRole("button", { name: "Open app" })
          .hasAttribute("disabled"),
      ).toBe(false);
    });

    it("drops the spent link on pagehide", async () => {
      await tapTwice();
      act(() => {
        window.dispatchEvent(new Event("pagehide"));
      });
      expect(screen.queryByRole("link", { name: "Open app" })).toBeNull();
      expect(document.body.textContent).toContain("for a new link");
    });

    it("swallows a second tap and drops the link shortly after", async () => {
      const link = await tapTwice();
      fireEvent.click(link);
      expect(swallowed).toEqual([false, true]);
      // The page never hid: the link still goes about a second later.
      expect(screen.getByRole("link", { name: "Open app" })).toBeTruthy();
      await waitFor(
        () =>
          expect(screen.queryByRole("link", { name: "Open app" })).toBeNull(),
        { timeout: 2_000 },
      );
      expect(document.body.textContent).toContain("for a new link");
      expect(createAppHandoff).toHaveBeenCalledTimes(1);
    });
  });
});
