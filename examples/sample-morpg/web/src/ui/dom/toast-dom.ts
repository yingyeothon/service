/* Toasts in the DOM, keyed by id so a countdown updates its text in place. */
import type { Toast, ToastDo } from "../toasts.js";

export interface ToastDom {
  render(toasts: Toast[]): void;
}

export function createToastDom(
  root: HTMLElement,
  on: (d: ToastDo) => void,
): ToastDom {
  const nodes = new Map<string, { el: HTMLElement; sig: string }>();
  const build = (t: Toast): HTMLElement => {
    const el = document.createElement("div");
    el.className = `toast ${t.kind}${t.tone ? ` k-${t.tone}` : ""}`;
    el.dataset.testid = `toast-${t.kind}`;
    el.setAttribute("role", t.kind === "line" ? "status" : "alertdialog");
    if (t.title) {
      const h = document.createElement("div");
      h.className = "title";
      h.textContent = t.title;
      el.append(h);
    }
    const p = document.createElement("div");
    p.className = "text";
    p.textContent = t.text;
    el.append(p);
    for (const l of t.lines ?? []) {
      const d = document.createElement("div");
      d.className = "line";
      d.textContent = l;
      el.append(d);
    }
    if (t.buttons.length > 0) {
      const row = document.createElement("div");
      row.className = "buttons";
      for (const b of t.buttons) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.tabIndex = -1;
        btn.textContent = b.label;
        btn.className = b.primary ? "primary" : "alt";
        btn.dataset.testid = `btn-${b.label.replace(/\s+/g, "-")}`;
        btn.addEventListener("click", (e) => {
          e.preventDefault();
          on(b.do);
        });
        row.append(btn);
      }
      el.append(row);
    }
    return el;
  };
  return {
    render(toasts) {
      const seen = new Set<string>();
      for (const t of toasts) {
        seen.add(t.id);
        const sig = JSON.stringify(t);
        const cur = nodes.get(t.id);
        if (cur && cur.sig === sig) continue;
        const el = build(t);
        if (cur) cur.el.replaceWith(el);
        else root.append(el);
        nodes.set(t.id, { el, sig });
      }
      for (const [id, n] of nodes)
        if (!seen.has(id)) {
          n.el.remove();
          nodes.delete(id);
        }
    },
  };
}
