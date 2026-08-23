import { Fragment, type ReactNode } from "react";

const URL_RE = /(https?:\/\/[^\s<>"')\]]+)/g;

/**
 * `bodyMd` is rendered as plain text: paragraphs split on blank lines, line
 * breaks kept, `https://` URLs linked. No HTML is ever interpreted, so a
 * proposal body cannot inject markup.
 */
export function renderBody(text: string): ReactNode {
  const paragraphs = text
    .replace(/\r\n?/g, "\n")
    .trim()
    .split(/\n{2,}/);
  if (paragraphs.length === 1 && paragraphs[0] === "") return null;
  return paragraphs.map((para, i) => (
    <p key={i}>
      {para.split("\n").map((line, j) => (
        <Fragment key={j}>
          {j > 0 && <br />}
          {linkify(line)}
        </Fragment>
      ))}
    </p>
  ));
}

function linkify(line: string): ReactNode {
  const parts = line.split(URL_RE);
  return parts.map((part, i) =>
    i % 2 === 1 ? (
      <a key={i} href={part} target="_blank" rel="noopener noreferrer">
        {part}
      </a>
    ) : (
      part
    ),
  );
}
