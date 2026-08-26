import { MantineProvider } from "@mantine/core";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Markdown } from "../src/components/Markdown";
import { theme } from "../src/theme";

function md(text: string) {
  return render(
    <MantineProvider theme={theme} forceColorScheme="light">
      <Markdown text={text} />
    </MantineProvider>,
  ).container;
}

describe("Markdown", () => {
  it("renders GFM (lists, tables, autolinks) with safe anchors", () => {
    const c = md(
      "# Title\n\n- one\n- two\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nsee https://x.test/a?b=1 and www.example.com",
    );
    expect(c.querySelector("h3")?.textContent).toBe("Title");
    expect(c.querySelectorAll("li")).toHaveLength(2);
    expect(c.querySelectorAll("td")).toHaveLength(2);
    const links = [...c.querySelectorAll("a")];
    expect(links.map((a) => a.getAttribute("href"))).toEqual([
      "https://x.test/a?b=1",
      "http://www.example.com",
    ]);
    for (const a of links) {
      expect(a.getAttribute("target")).toBe("_blank");
      expect(a.getAttribute("rel")).toBe("noopener noreferrer nofollow ugc");
    }
  });

  it("drops raw HTML entirely: no script, no img, no handlers", () => {
    const c = md(
      'before <script>window.pwned=1</script> <img src=x onerror="alert(1)"> <b onclick="x()">bold</b> after',
    );
    expect(c.querySelector("script")).toBeNull();
    expect(c.querySelector("img")).toBeNull();
    expect(c.querySelector("[onerror], [onclick]")).toBeNull();
    // skipHtml removes the tags rather than escaping them into visible text.
    expect(c.textContent).not.toContain("<script>");
    expect(c.textContent).toContain("before");
    expect(c.textContent).toContain("after");
  });

  it("removes images even in markdown syntax", () => {
    const c = md("![alt](https://x.test/a.png)");
    expect(c.querySelector("img")).toBeNull();
  });

  it("keeps only http(s) links: javascript, data and mailto lose their href", () => {
    const c = md(
      "[js](javascript:alert(1)) [data](data:text/html,x) [mail](mailto:a@b.c) [ok](http://x.test/) [ok2](https://x.test/?a=1)",
    );
    const links = [...c.querySelectorAll("a")];
    expect(links.map((a) => a.getAttribute("href"))).toEqual([
      "http://x.test/",
      "https://x.test/?a=1",
    ]);
    // The unlinked ones still show their text, as text.
    expect(c.textContent).toContain("js");
    expect(c.textContent).toContain("mail");
  });

  it("drops obfuscated schemes, reference links, autolinks and relative hrefs", () => {
    const c = md(
      [
        "[a](<java\tscript:alert(1)>)",
        "[b](&#106;avascript:alert(1))",
        "[c](JAVASCRIPT:alert(1))",
        "[d](vbscript:msgbox(1))",
        "[e]",
        "",
        "[e]: javascript:alert(1)",
        "",
        "<javascript:alert(1)>",
        "[f](javascript%3Aalert(1))",
        "[g](//evil.test/x)",
        "[h](/channels/auth_1)",
        "[![i](https://x.test/a.png)](https://x.test/ok)",
        "<!-- c --><?php x ?>",
      ].join("\n"),
    );
    const hrefs = [...c.querySelectorAll("a")].map((a) =>
      a.getAttribute("href"),
    );
    expect(hrefs).toEqual(["https://x.test/ok"]);
    expect(c.querySelector("img")).toBeNull();
    expect(c.textContent).not.toContain("php");
  });

  it("does not forward link titles or code classes", () => {
    const c = md(
      '[t](https://x.test/ "spoof")\n\n```language-x" onclick=x\ncode\n```',
    );
    expect(c.querySelector("a")?.getAttribute("title")).toBeNull();
    expect(c.querySelector("code")?.className ?? "").not.toContain("language-");
  });

  it("keeps footnote back-references resolvable with a single id prefix", () => {
    const c = md("a[^1]\n\n[^1]: note");
    const ref = c.querySelector("a[href^='#']");
    expect(ref).not.toBeNull();
    const target = ref!.getAttribute("href")!.slice(1);
    expect(c.querySelector(`[id='${target}']`)).not.toBeNull();
    expect(target.startsWith("user-content-")).toBe(true);
    expect(target.startsWith("user-content-user-content-")).toBe(false);
    // In-page links stay in the page: no new tab.
    expect(ref!.getAttribute("target")).toBeNull();
  });

  it("does not autolink data: literals", () => {
    const c = md("data:text/html,<script>x</script>");
    expect(c.querySelector("a")).toBeNull();
    expect(c.querySelector("script")).toBeNull();
  });

  it("prefixes heading ids so they cannot clobber DOM globals", () => {
    const c = md('<a id="location">x</a>\n\n# location');
    expect(c.querySelector("#location")).toBeNull();
  });

  it("renders nothing for a blank body", () => {
    expect(md("  \n ").querySelector(".markdown")).toBeNull();
  });
});
