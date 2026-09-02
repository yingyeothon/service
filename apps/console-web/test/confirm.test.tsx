import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { useConfirm, type ConfirmResult } from "../src/lib/confirm";
import { mount } from "./wrap";

function Harness({ reason }: { reason?: { required: boolean } }) {
  const confirm = useConfirm();
  const [result, setResult] = useState<ConfirmResult | null>(null);
  return (
    <>
      <button
        onClick={() =>
          void confirm({
            title: "Close the vote?",
            message: "Nobody can vote afterwards.",
            confirmLabel: "Yes, close it",
            reason,
          }).then(setResult)
        }
      >
        Close the vote
      </button>
      <output>{result ? JSON.stringify(result) : ""}</output>
    </>
  );
}

describe("useConfirm", () => {
  it("resolves ok on the verb button and not ok on cancel", async () => {
    mount(<Harness />, { auth: false });
    await userEvent.click(
      screen.getByRole("button", { name: "Close the vote" }),
    );
    let dialog = await screen.findByRole("dialog");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Cancel" }),
    );
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent('{"ok":false}'),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Close the vote" }),
    );
    dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText("Nobody can vote afterwards."),
    ).toBeInTheDocument();
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Yes, close it" }),
    );
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent('{"ok":true}'),
    );
  });
  it("demands a reason when required and hands it on", async () => {
    mount(<Harness reason={{ required: true }} />, { auth: false });
    await userEvent.click(
      screen.getByRole("button", { name: "Close the vote" }),
    );
    const dialog = await screen.findByRole("dialog");
    const ok = within(dialog).getByRole("button", { name: "Yes, close it" });
    expect(ok).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText(/Reason/), "spam");
    expect(ok).toBeEnabled();
    await userEvent.click(ok);
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        '{"ok":true,"reason":"spam"}',
      ),
    );
  });
});
