import { MantineProvider } from "@mantine/core";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

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

function mount(nav: Partial<Navigator>, go = vi.fn()) {
  render(
    <MantineProvider theme={theme} forceColorScheme="light">
      <OpenAppButton nav={nav} go={go} />
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
