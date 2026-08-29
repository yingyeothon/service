/* The text panels: the same side/overlay lines as the terminal, the log, the input line. */
import type { Templates } from "../../src/templates.js";
import { inputHint, overlayLines, sideLines } from "../../client/render.js";
import type { AppState } from "../../client/state.js";

export interface Panels {
  paint(state: AppState, templates: Templates | undefined, now: number): void;
}

export function createPanels(el: {
  side: HTMLElement;
  log: HTMLElement;
  input: HTMLElement;
}): Panels {
  let lastLogSeq = 0;
  const lineEl = (text: string, kind?: string): HTMLDivElement => {
    const div = document.createElement("div");
    if (kind) div.className = `k-${kind}`;
    div.textContent = text; // never innerHTML: chat text comes from peers
    return div;
  };
  return {
    paint(state, templates, now) {
      const lines = state.overlay
        ? overlayLines(state.overlay)
        : sideLines(state, templates, now);
      el.side.replaceChildren(...lines.map((l) => lineEl(l.text, l.kind)));
      const fresh = state.log.filter((l) => l.seq > lastLogSeq);
      if (fresh.length > 0) {
        const atBottom =
          el.log.scrollTop + el.log.clientHeight >= el.log.scrollHeight - 4;
        for (const l of fresh) el.log.append(lineEl(l.text, l.kind));
        while (el.log.childElementCount > 300)
          el.log.firstElementChild?.remove();
        lastLogSeq = fresh.at(-1)!.seq;
        if (atBottom) el.log.scrollTop = el.log.scrollHeight;
      }
      el.input.replaceChildren(
        state.input !== undefined
          ? lineEl(`> ${state.input}_`)
          : lineEl(inputHint(state, "/quit"), "dim"),
      );
    },
  };
}
