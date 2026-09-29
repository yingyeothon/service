import { Text } from "@mantine/core";
import { Suspense, lazy } from "react";
import { ChunkBoundary } from "./ChunkBoundary";

// A dynamic import (no static re-export of the body's helpers) is what keeps
// react-markdown, remark-gfm and rehype-sanitize in their own chunk.
const Body = lazy(() => import("./MarkdownBody"));

/**
 * The one markdown renderer of the console: team descriptions, discussions,
 * issues, comments and event/proposal bodies all go through it. Anything the
 * schema does not allow is dropped, never escaped into visible text. While
 * the renderer chunk loads — and for good if it never does — the raw text
 * shows as pre-wrapped plain text, about the rendered height, so the page
 * does not jump and a lost chunk costs the formatting, not the page.
 */
export function Markdown({ text }: { text: string }) {
  if (text.trim() === "") return null;
  const plain = (
    <Text size="sm" my="xs" style={{ whiteSpace: "pre-wrap" }}>
      {text}
    </Text>
  );
  return (
    <ChunkBoundary fallback={plain}>
      <Suspense fallback={plain}>
        <Body text={text} />
      </Suspense>
    </ChunkBoundary>
  );
}
