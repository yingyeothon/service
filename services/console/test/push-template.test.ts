import { describe, expect, it } from "vitest";
import { AppError } from "@yyt/core";
import {
  checkMessageText,
  createRenderer,
  literalMessage,
  PUSH_VAR_NAME,
  templateVars,
} from "../src/push-template.js";

const text = (title: string, body = "", data: Record<string, string> = {}) => ({
  title,
  body,
  data,
});

const refusal = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof AppError)
      return {
        code: e.code,
        reason: (e.details as { reason?: string })?.reason,
      };
    throw e;
  }
  return undefined;
};

describe("push template grammar", () => {
  it("names a variable as a letter or underscore and up to 31 more word characters", () => {
    for (const ok of ["a", "_", "userId", "A_1", "x".repeat(32)])
      expect(PUSH_VAR_NAME.test(ok), ok).toBe(true);
    for (const bad of ["", "1a", "a-b", "a.b", "a b", "x".repeat(33), "가"])
      expect(PUSH_VAR_NAME.test(bad), bad).toBe(false);
  });

  it("finds the variables of title, body and data values, sorted and once each", () => {
    expect(
      templateVars(
        text("Hi {{name}}", "{{amount}} for {{name}}", {
          link: "app://{{userId}}",
          "{{notAVar}}": "literal key",
        }),
      ),
    ).toEqual(["amount", "name", "userId"]);
    expect(templateVars(text("plain"))).toEqual([]);
  });

  it("treats everything that is not exactly {{name}} as literal text", () => {
    const literal = [
      "{{ name }}",
      "{{name }}",
      "{{a.b}}",
      "{{}}",
      "{{",
      "}}",
      "{name}",
      "{{1a}}",
      `{{${"x".repeat(33)}}}`,
      "{{a-b}}",
    ];
    for (const s of literal) {
      expect(templateVars(text(s)), s).toEqual([]);
      const r = createRenderer(text(s))(() => "V");
      expect(r, s).toEqual({
        ok: true,
        message: { notification: { title: s, body: "" } },
      });
    }
    // Braces around a placeholder stay; the inner pair is the placeholder.
    expect(createRenderer(text("{{{a}}}"))(() => "V")).toEqual({
      ok: true,
      message: { notification: { title: "{V}", body: "" } },
    });
  });

  it("substitutes in one pass: a value is never read as a template", () => {
    const render = createRenderer(
      text("{{a}}{{b}}", "{{a}}", { k: "<{{b}}>", fixed: "x" }),
    );
    const values: Record<string, string> = { a: "{{b}}", b: "$&$1" };
    expect(render((n) => values[n])).toEqual({
      ok: true,
      message: {
        notification: { title: "{{b}}$&$1", body: "{{b}}" },
        data: { k: "<$&$1>", fixed: "x" },
      },
    });
  });

  it("reports a row whose variable is empty or absent", () => {
    const render = createRenderer(text("Hi {{name}}", "", { n: "{{count}}" }));
    expect(render((n) => (n === "name" ? "Ann" : ""))).toEqual({
      ok: false,
      reason: "missing-variable",
    });
    expect(render((n) => (n === "name" ? "Ann" : undefined))).toEqual({
      ok: false,
      reason: "missing-variable",
    });
    expect(render(() => "x")).toMatchObject({ ok: true });
  });

  it("reports a row whose rendered message passes 4096 bytes", () => {
    const render = createRenderer(text("{{a}}"));
    // `{"notification":{"title":"…","body":""}}` is 39 bytes around the title.
    expect(render(() => "x".repeat(4096 - 39))).toMatchObject({ ok: true });
    expect(render(() => "x".repeat(4096 - 38))).toEqual({
      ok: false,
      reason: "too-large",
    });
    // Bytes, not characters.
    expect(render(() => "가".repeat(1400))).toEqual({
      ok: false,
      reason: "too-large",
    });
  });

  it("sends data only without a title, and no data key when there is none", () => {
    expect(createRenderer(text("", "", { a: "{{x}}" }))(() => "1")).toEqual({
      ok: true,
      message: { data: { a: "1" } },
    });
    expect(createRenderer(text("T", "B"))(() => "1")).toEqual({
      ok: true,
      message: { notification: { title: "T", body: "B" } },
    });
  });
});

describe("checkMessageText", () => {
  it("returns the stored shape with defaults", () => {
    expect(checkMessageText({ title: "T" })).toEqual(text("T"));
    expect(checkMessageText({ data: { a: "b" } })).toEqual(
      text("", "", { a: "b" }),
    );
    expect(
      checkMessageText({
        title: "T",
        body: "line\n\ttab",
        data: { a: "x\ny" },
      }),
    ).toEqual(text("T", "line\n\ttab", { a: "x\ny" }));
  });

  it("refuses what the send route refuses", () => {
    const bad = (raw: Parameters<typeof checkMessageText>[0]) =>
      refusal(() => checkMessageText(raw));
    expect(bad({})).toEqual({ code: "bad_request", reason: undefined });
    expect(bad({ body: "no title" })?.code).toBe("bad_request");
    expect(bad({ title: "x".repeat(1025) })?.code).toBe("bad_request");
    expect(bad({ title: "T", body: "x".repeat(4097) })?.code).toBe(
      "bad_request",
    );
    expect(bad({ title: "a\nb" })?.code).toBe("bad_request");
    expect(bad({ title: "T", body: "a\u0000b" })?.code).toBe("bad_request");
    expect(bad({ title: "T", data: { a: "x\u0007" } })?.code).toBe(
      "bad_request",
    );
    expect(bad({ title: "T", data: { "a\nb": "x" } })?.code).toBe(
      "bad_request",
    );
    expect(bad({ title: "T", data: { a: 1 } })?.code).toBe("bad_request");
    expect(bad({ title: "T", data: { from: "x" } })?.code).toBe("bad_request");
    expect(bad({ title: "T", data: { "gcm.x": "x" } })?.code).toBe(
      "bad_request",
    );
    expect(bad({ title: "T", data: { "": "x" } })?.code).toBe("bad_request");
    expect(
      bad({
        title: "T",
        data: Object.fromEntries(
          Array.from({ length: 65 }, (_, i) => [`k${i}`, "v"]),
        ),
      })?.code,
    ).toBe("bad_request");
    expect(
      bad({ title: "T", data: [] as unknown as Record<string, unknown> })?.code,
    ).toBe("bad_request");
  });

  it("refuses a message whose literal text alone passes the payload limit", () => {
    const big = { title: "T", data: { a: "x".repeat(4096) } };
    expect(refusal(() => checkMessageText(big))).toEqual({
      code: "bad_request",
      reason: "push_payload_too_large",
    });
    // Placeholders count as one byte each: this one can still fit.
    const body = "x".repeat(4000);
    expect(
      checkMessageText({ title: "{{aVeryLongVariableNameHere}}", body }),
    ).toMatchObject({ body });
  });
});

describe("literalMessage", () => {
  it("is the message as written, and refuses a variable", () => {
    expect(literalMessage(text("T", "B", { a: "b" }))).toEqual({
      notification: { title: "T", body: "B" },
      data: { a: "b" },
    });
    expect(literalMessage(text("{{ not one }}"))).toEqual({
      notification: { title: "{{ not one }}", body: "" },
    });
    expect(refusal(() => literalMessage(text("Hi {{name}}")))).toEqual({
      code: "bad_request",
      reason: "template_has_variables",
    });
  });
});
