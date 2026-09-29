import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CliInstallCard, isWindowsBrowser } from "../src/pages/Home";
import { mount } from "./wrap";

/*
 * The CLI install card carries one copyable line per OS family, so a Windows
 * user is not handed a `curl … | sh` that Git Bash rejects; the Releases link
 * is the fallback for every other case.
 */

describe("CliInstallCard", () => {
  it("offers the sh and PowerShell one-liners and the Releases link", () => {
    mount(<CliInstallCard />, { auth: false });
    expect(screen.getByText(/install\.sh \| sh$/)).toBeInTheDocument();
    expect(screen.getByText(/install\.ps1 \| iex$/)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Copy macOS / Linux" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Copy Windows (PowerShell)" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "GitHub Releases" }),
    ).toHaveAttribute("href", expect.stringContaining("/releases"));
  });

  it("puts the Windows line first on a Windows browser", () => {
    expect(isWindowsBrowser({ platform: "Win32" })).toBe(true);
    expect(isWindowsBrowser({ platform: "MacIntel" })).toBe(false);
    expect(
      isWindowsBrowser({
        platform: "Linux x86_64",
        userAgentData: { platform: "Windows" },
      } as Partial<Navigator>),
    ).toBe(true);
  });
});
