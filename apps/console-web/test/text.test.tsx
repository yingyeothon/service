import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderBody } from "../src/lib/text";

describe("renderBody", () => {
  it("splits paragraphs, keeps line breaks, links URLs and never injects HTML", () => {
    const { container } = render(
      <div>
        {renderBody(
          "first <b>bold</b>\nsecond https://x.test/a?b=1 tail\r\n\r\nthird",
        )}
      </div>,
    );
    const ps = container.querySelectorAll("p");
    expect(ps).toHaveLength(2);
    expect(ps[0]!.querySelector("b")).toBeNull();
    expect(ps[0]!.textContent).toContain("<b>bold</b>");
    expect(ps[0]!.querySelector("br")).not.toBeNull();
    const a = ps[0]!.querySelector("a")!;
    expect(a.getAttribute("href")).toBe("https://x.test/a?b=1");
    expect(a.getAttribute("rel")).toContain("noopener");
    expect(ps[1]!.textContent).toBe("third");
  });

  it("renders nothing for an empty body", () => {
    expect(renderBody("  \n ")).toBeNull();
  });
});
