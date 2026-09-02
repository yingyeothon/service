import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { notify } from "../src/lib/notify";
import { mount } from "./wrap";

describe("notify", () => {
  it("speaks the fixed vocabulary", async () => {
    mount(<div />, { auth: false });
    notify.created("team");
    notify.saved("project");
    notify.deleted("channel");
    notify.done("Secret rotated");
    expect(await screen.findByText("Team created")).toBeInTheDocument();
    expect(screen.getByText("Project saved")).toBeInTheDocument();
    expect(screen.getByText("Channel deleted")).toBeInTheDocument();
    expect(screen.getByText("Secret rotated")).toBeInTheDocument();
  });
});
