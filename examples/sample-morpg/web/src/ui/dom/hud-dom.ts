/* The HUD in the DOM: top bar (place, hp, level, target), icon buttons, the action cluster. */
import type { Key } from "../../../../client/commands.js";
import type { HudButton, HudModel } from "../hud.js";

export interface HudDom {
  render(m: HudModel | undefined): void;
}

export interface HudHandlers {
  press(key: Key): void;
  /** A tap on a disabled button: its reason (touch has no hover for `title`). */
  hint(text: string): void;
  /** The web-only `menu` button. */
  menu(): void;
}

const ICON_GLYPH: Record<string, string> = {
  primary: "",
  skill: "✦",
  target: "◎",
  reject: "✕",
  bag: "🎒",
  char: "👤",
  quests: "📜",
  party: "👥",
  chat: "💬",
  menu: "☰",
};

export function createHudDom(
  el: {
    top: HTMLElement;
    icons: HTMLElement;
    actions: HTMLElement;
  },
  on: HudHandlers,
): HudDom {
  const place = document.createElement("span");
  place.id = "place";
  place.dataset.testid = "place";
  const hpBox = document.createElement("div");
  hpBox.id = "hp";
  hpBox.dataset.testid = "hp";
  const hpFill = document.createElement("div");
  hpFill.className = "fill";
  const hpText = document.createElement("span");
  hpBox.append(hpFill, hpText);
  const level = document.createElement("span");
  level.id = "level";
  const target = document.createElement("span");
  target.id = "target";
  target.dataset.testid = "target";
  el.top.replaceChildren(place, hpBox, level, target);

  const buttons = new Map<string, HTMLButtonElement>();
  const button = (b: HudButton, parent: HTMLElement): HTMLButtonElement => {
    let node = buttons.get(b.id);
    if (!node) {
      node = document.createElement("button");
      node.type = "button";
      node.tabIndex = -1; // Enter on the keyboard must reach the game, not click a focused button
      node.dataset.testid = `btn-${b.id}`;
      node.className = `hud ${b.id}`;
      const glyph = document.createElement("span");
      glyph.className = "glyph";
      glyph.textContent = ICON_GLYPH[b.id] ?? "";
      const label = document.createElement("span");
      label.className = "label";
      const badge = document.createElement("span");
      badge.className = "badge";
      node.append(glyph, label, badge);
      node.addEventListener("click", (e) => {
        e.preventDefault();
        const key = keys.get(b.id);
        const why = hints.get(b.id);
        if (why !== undefined) on.hint(why);
        else if (b.id === "menu") on.menu();
        else if (key) on.press(key);
      });
      buttons.set(b.id, node);
    }
    if (node.parentElement !== parent) parent.append(node);
    return node;
  };
  const keys = new Map<string, Key>();
  /** Set while a button is disabled: the tap explains instead of acting. */
  const hints = new Map<string, string>();
  const paint = (b: HudButton, parent: HTMLElement): void => {
    const node = button(b, parent);
    if (b.key) keys.set(b.id, b.key);
    // `aria-disabled`, not `disabled`: a disabled control swallows the tap that would explain it.
    node.classList.toggle("off", !b.enabled);
    node.setAttribute("aria-disabled", String(!b.enabled));
    if (b.enabled) hints.delete(b.id);
    else hints.set(b.id, `${b.label}: ${b.hint ?? "unavailable"}`);
    node.title = b.enabled ? b.label : `${b.label}: ${b.hint ?? "unavailable"}`;
    node.setAttribute("aria-label", node.title);
    (node.querySelector(".label") as HTMLElement).textContent = b.label;
    const badge = node.querySelector(".badge") as HTMLElement;
    badge.textContent = b.badge !== undefined ? String(b.badge) : "";
    badge.hidden = b.badge === undefined;
  };

  let last = "";
  return {
    render(m) {
      if (!m) {
        el.actions.replaceChildren();
        el.icons.replaceChildren();
        last = "";
        return;
      }
      const sig = JSON.stringify(m);
      if (sig === last) return;
      last = sig;
      place.textContent = m.mode === "dungeon" ? `field · ${m.place}` : m.place;
      if (m.hp) {
        hpBox.hidden = false;
        const pct = m.hp.max > 0 ? Math.max(0, m.hp.cur) / m.hp.max : 0;
        hpFill.style.width = `${Math.round(pct * 100)}%`;
        hpFill.classList.toggle("low", pct <= 0.3);
        hpText.textContent = m.hp.alive ? `${m.hp.cur}/${m.hp.max}` : `dead`;
      } else hpBox.hidden = true;
      level.textContent = m.level
        ? `Lv ${m.level.level}${m.level.points > 0 ? ` · ${m.level.points} pts` : ""}`
        : "";
      target.textContent = m.target
        ? `▸ ${m.target.templateId} #${m.target.uid} ${m.target.hp}/${m.target.maxHp}${m.target.adjacent ? "" : " (far)"}`
        : "";
      target.hidden = !m.target;
      // Buttons that left the model leave the DOM (skill/target in town, reject when nothing is pending).
      const wanted = new Set<string>([
        m.primary.id,
        ...m.actions.map((b) => b.id),
        ...m.icons.map((b) => b.id),
      ]);
      for (const [id, node] of buttons)
        if (!wanted.has(id)) {
          node.remove();
          buttons.delete(id);
        }
      paint(m.primary, el.actions);
      for (const b of m.actions) paint(b, el.actions);
      for (const b of m.icons) paint(b, el.icons);
    },
  };
}
