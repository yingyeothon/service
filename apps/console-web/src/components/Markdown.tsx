import { Anchor, Code, Table, Text, Title } from "@mantine/core";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeSanitize, { defaultSchema, type Options } from "rehype-sanitize";
import remarkGfm from "remark-gfm";

/**
 * Sanitize schema (docs/decisions.md *Teams and projects*): no raw HTML (also
 * `skipHtml`), no images, `http(s)` links only — `mailto:`/`data:`/
 * `javascript:` are dropped with the attribute. The default schema already
 * prefixes `id`s so a heading cannot clobber a DOM global.
 */
export const SANITIZE_SCHEMA: Options = {
  ...defaultSchema,
  tagNames: (defaultSchema.tagNames ?? []).filter((t) => t !== "img"),
  protocols: { ...defaultSchema.protocols, href: ["http", "https"] },
  // remark-rehype already prefixes footnote ids with `user-content-`; a second
  // prefix here would break the back-references without adding safety.
  clobberPrefix: "",
};

/**
 * "http(s) links only" taken literally: the sanitizer only judges URLs that
 * carry a scheme, so `//host` and `/path` would survive it — and a root
 * relative link in user content reads as an internal console link. In-page
 * fragments (`#…`, footnotes) stay.
 */
export const linkUrl = (url: string): string =>
  /^https?:\/\//i.test(url) || url.startsWith("#") ? url : "";

/** Anchors open a new tab and never pass referrer, focus or ranking. */
const LINK_REL = "noopener noreferrer nofollow ugc";

const components: Components = {
  // `title` is dropped: a tooltip that names a different destination than
  // the href is a spoof surface and nothing else.
  a: ({ node: _node, href, title: _title, children, ...rest }) =>
    !href ? (
      // A dropped href leaves plain text, not an anchor to the current page.
      <>{children}</>
    ) : href.startsWith("#") ? (
      <Anchor href={href} {...rest}>
        {children}
      </Anchor>
    ) : (
      <Anchor href={href} target="_blank" rel={LINK_REL} {...rest}>
        {children}
      </Anchor>
    ),
  h1: ({ node: _node, ...p }) => <Title order={3} my="xs" {...p} />,
  h2: ({ node: _node, ...p }) => <Title order={4} my="xs" {...p} />,
  h3: ({ node: _node, ...p }) => <Title order={5} my="xs" {...p} />,
  h4: ({ node: _node, ...p }) => <Title order={6} my="xs" {...p} />,
  h5: ({ node: _node, ...p }) => <Title order={6} my="xs" {...p} />,
  h6: ({ node: _node, ...p }) => <Title order={6} my="xs" {...p} />,
  p: ({ node: _node, ...p }) => <Text size="sm" my="xs" {...p} />,
  // The fenced-code info string only decides block vs inline; it is never
  // forwarded as a class (a future highlighter must not key on user input).
  code: ({ node: _node, className, children, ...p }) =>
    className?.startsWith("language-") ? (
      <Code block {...p}>
        {children}
      </Code>
    ) : (
      <Code {...p}>{children}</Code>
    ),
  pre: ({ node: _node, children }) => <>{children}</>,
  table: ({ node: _node, children }) => (
    <Table.ScrollContainer minWidth={320}>
      <Table withTableBorder>{children}</Table>
    </Table.ScrollContainer>
  ),
  thead: ({ node: _node, ...p }) => <Table.Thead {...p} />,
  tbody: ({ node: _node, ...p }) => <Table.Tbody {...p} />,
  tr: ({ node: _node, ...p }) => <Table.Tr {...p} />,
  th: ({ node: _node, ...p }) => <Table.Th {...p} />,
  td: ({ node: _node, ...p }) => <Table.Td {...p} />,
};

/**
 * The one markdown renderer of the console: team descriptions, discussions,
 * issues, comments and event/proposal bodies all go through it. Anything the
 * schema does not allow is dropped, never escaped into visible text.
 */
export function Markdown({ text }: { text: string }) {
  if (text.trim() === "") return null;
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeSanitize, SANITIZE_SCHEMA]]}
        urlTransform={linkUrl}
        skipHtml
        components={components}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
