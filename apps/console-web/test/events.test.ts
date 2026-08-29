import { describe, expect, it } from "vitest";
import { diffLines, revisionText } from "../src/lib/diff";
import {
  buildEventInput,
  emptyEventForm,
  formFromEvent,
  fromLocalInput,
  toLocalInput,
} from "../src/lib/eventForm";
import type { EventDetail } from "../src/types";

describe("diffLines", () => {
  it("marks removed and added lines and keeps common ones", () => {
    expect(
      diffLines("a\nb\nc\n", "a\nc\nd\n")
        .map((l) => l.op + l.text)
        .join("|"),
    ).toBe(" a|-b| c|+d");
    expect(diffLines("", "")).toEqual([]);
    expect(diffLines("x", "x")).toEqual([{ op: " ", text: "x" }]);
  });

  it("renders a revision as the same text the CLI diffs", () => {
    const text = revisionText({
      revision: 1,
      editedBy: "a",
      editedAt: 0,
      title: "T",
      place: "P",
      placeUrl: null,
      durationHours: 8,
      posterKey: "posters/x.png",
      bodyMd: "body",
    });
    expect(text).toBe(
      "title: T\nplace: P\nplaceUrl: -\ndurationHours: 8\nposter: posters/x.png\n---\nbody\n",
    );
  });
});

describe("event form", () => {
  const local = (v: string) => fromLocalInput(v)!;
  it("round-trips datetime-local values in the browser zone", () => {
    const sec = local("2026-09-12T14:00");
    expect(toLocalInput(sec)).toBe("2026-09-12T14:00");
    expect(fromLocalInput("")).toBeNull();
    expect(fromLocalInput("nope")).toBeNull();
    expect(toLocalInput(null)).toBe("");
  });

  it("validates the schedule and sorts options", () => {
    const f = {
      ...emptyEventForm(),
      title: " 잉여톤 36 ",
      place: "Seoul",
      placeUrl: "",
      durationHours: 8,
      voteUntil: "2026-09-01T12:00",
      options: ["2026-09-19T14:00", "", "2026-09-12T14:00"],
    };
    const ok = buildEventInput(f, true);
    expect(ok.error).toBeNull();
    expect(ok.input).toEqual({
      title: "잉여톤 36",
      bodyMd: "",
      place: "Seoul",
      placeUrl: null,
      durationHours: 8,
      voteUntil: local("2026-09-01T12:00"),
      options: [local("2026-09-12T14:00"), local("2026-09-19T14:00")],
    });
    expect(buildEventInput({ ...f, title: " " }, true).error).toMatch(/Title/);
    expect(buildEventInput({ ...f, place: "" }, true).error).toMatch(/Place/);
    expect(buildEventInput({ ...f, placeUrl: "ftp://x" }, true).error).toMatch(
      /http/,
    );
    expect(buildEventInput({ ...f, durationHours: 0 }, true).error).toMatch(
      /Duration/,
    );
    expect(buildEventInput({ ...f, voteUntil: "" }, true).error).toMatch(
      /deadline/,
    );
    expect(buildEventInput({ ...f, options: [""] }, true).error).toMatch(
      /candidate/,
    );
    expect(
      buildEventInput(
        { ...f, options: ["2026-09-12T14:00", "2026-09-12T14:00"] },
        true,
      ).error,
    ).toMatch(/differ/);
    expect(
      buildEventInput({ ...f, options: ["2026-08-12T14:00"] }, true).error,
    ).toMatch(/after the vote deadline/);
    // past draft: only the page is sent, schedule fields are ignored
    expect(buildEventInput({ ...f, voteUntil: "" }, false)).toEqual({
      input: { title: "잉여톤 36", bodyMd: "", place: "Seoul", placeUrl: null },
      error: null,
    });
  });

  it("pre-fills the form from an event", () => {
    const e = {
      title: "T",
      bodyMd: "b",
      place: "P",
      placeUrl: "https://m",
      durationHours: 4,
      voteUntil: local("2026-09-01T12:00"),
      options: [{ id: "o1", startsAt: local("2026-09-12T14:00"), mine: false }],
    } as unknown as EventDetail;
    expect(formFromEvent(e)).toEqual({
      title: "T",
      bodyMd: "b",
      place: "P",
      placeUrl: "https://m",
      durationHours: 4,
      voteUntil: "2026-09-01T12:00",
      options: ["2026-09-12T14:00"],
    });
  });
});
