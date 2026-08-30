/*
 * The popup sheet in the DOM: a header (portrait, title, close), rows as
 * buttons (a disabled row shows its reason), and the character/quest views.
 * Rebuilt only when the model's signature changes; text via `textContent`
 * only (ids and labels can be peer-influenced).
 */
import type { Key } from "../../../../client/commands.js";
import type { KeyedChoice } from "../../../../client/state.js";
import type { Sheets } from "../../sheets.js";
import type { DialogModel, DialogRow } from "../dialog.js";
import { KEYS } from "../hud.js";
import { cellRect, portraitCell, type PortraitRef } from "../portrait.js";

export interface DialogDom {
  render(m: DialogModel | undefined, sheets: Sheets | undefined): void;
  /** Whether a popup is up (the map is inert then). */
  readonly open: boolean;
}

export interface DialogHandlers {
  pick(c: KeyedChoice): void;
  /** Keys pressed in order (close, then open another menu). */
  press(keys: Key[]): void;
}

const PORTRAIT_SCALE = 3;

function portrait(
  sheets: Sheets | undefined,
  ref: PortraitRef,
  fallback: string,
): HTMLElement {
  const cell = sheets ? portraitCell(sheets, ref) : undefined;
  if (sheets && cell !== undefined) {
    const r = cellRect(sheets.actors, cell);
    const c = document.createElement("canvas");
    c.className = "portrait";
    c.width = r.w * PORTRAIT_SCALE;
    c.height = r.h * PORTRAIT_SCALE;
    const ctx = c.getContext("2d");
    if (ctx) {
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(
        sheets.actorsImage,
        r.sx,
        r.sy,
        r.w,
        r.h,
        0,
        0,
        c.width,
        c.height,
      );
    }
    return c;
  }
  const span = document.createElement("span");
  span.className = "portrait mark";
  span.textContent = fallback;
  return span;
}

export function createDialogDom(
  root: HTMLElement,
  on: DialogHandlers,
): DialogDom {
  let last = "";
  let open = false;
  const text = (cls: string, s: string, tag = "div"): HTMLElement => {
    const d = document.createElement(tag);
    d.className = cls;
    d.textContent = s;
    return d;
  };
  const rowButton = (r: DialogRow, sheets: Sheets | undefined): HTMLElement => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `row${r.disabled ? " off" : ""}`;
    b.dataset.testid = "row";
    b.dataset.key = r.choice.key;
    if (r.disabled) b.disabled = true;
    if (r.icon)
      b.append(
        portrait(
          sheets,
          {
            kind: "item",
            id: r.choice.ref.kind === "item" ? r.choice.ref.id : "",
          },
          "•",
        ),
      );
    else if (r.choice.ref.kind === "npc")
      b.append(
        portrait(sheets, { kind: "npc", id: r.choice.ref.id }, r.badge ?? "?"),
      );
    const body = document.createElement("div");
    body.className = "body";
    body.append(text("t", r.title));
    if (r.sub) body.append(text("s", r.sub));
    b.append(body);
    if (r.badge)
      b.append(text(`b${r.status ? ` q-${r.status}` : ""}`, r.badge, "span"));
    if (r.disabled) b.append(text("v off", r.disabled, "span"));
    else if (r.verb) b.append(text("v", r.verb, "span"));
    b.addEventListener("click", (e) => {
      e.preventDefault();
      on.pick(r.choice);
    });
    return b;
  };
  const build = (m: DialogModel, sheets: Sheets | undefined): void => {
    root.replaceChildren();
    root.dataset.dialog = m.kind;
    root.setAttribute("aria-label", m.title);
    const head = document.createElement("div");
    head.className = "head";
    if (m.npc)
      head.append(portrait(sheets, { kind: "npc", id: m.npc.id }, m.npc.mark));
    const titles = document.createElement("div");
    titles.className = "titles";
    titles.append(text("title", m.title, "h2"));
    if (m.npc)
      titles.append(
        text(
          "sub",
          m.npc.role === "gate"
            ? "gate keeper"
            : m.npc.role === "dungeon"
              ? "dungeon entrance"
              : "quest giver",
        ),
      );
    else if (m.party)
      titles.append(
        text(
          "sub",
          m.party.size > 0
            ? `${m.party.size}/${m.party.max}${m.party.youLead ? " · you lead" : ""}`
            : "no party",
        ),
      );
    else if (m.pointsLeft !== undefined)
      titles.append(text("sub", `${m.pointsLeft} left`));
    head.append(titles);
    const close = document.createElement("button");
    close.type = "button";
    close.className = "close";
    close.dataset.testid = "dialog-close";
    close.setAttribute("aria-label", "close");
    close.textContent = "✕";
    close.addEventListener("click", (e) => {
      e.preventDefault();
      on.press([KEYS.escape]);
    });
    head.append(close);
    root.append(head);

    const body = document.createElement("div");
    body.className = "content";
    if (m.party && m.party.members.length > 0) {
      const list = document.createElement("div");
      list.className = "members";
      for (const x of m.party.members) {
        const d = text("member", "");
        d.append(text("t", `${x.short}${x.you ? " (you)" : ""}`, "span"));
        if (x.leader) d.append(text("b", "leader", "span"));
        if (!x.online) d.append(text("b off", "offline", "span"));
        list.append(d);
      }
      body.append(list);
    }
    if (m.character) {
      const v = m.character;
      if (m.kind === "character") {
        const grid = document.createElement("div");
        grid.className = "stats";
        const stat = (k: string, val: string): void => {
          grid.append(text("k", k, "span"), text("val", val, "span"));
        };
        stat("level", `${v.level}`);
        stat("exp", `${v.exp}`);
        const eff = (a: number, b: number) =>
          a === b ? `${a}` : `${a} (${b})`;
        stat("hp", eff(v.effective.maxHp, v.base.maxHp));
        stat("attack", eff(v.effective.attack, v.base.attack));
        stat("defence", eff(v.effective.defence, v.base.defence));
        stat("weapon", v.equipment.weapon ?? "—");
        stat("armor", v.equipment.armor ?? "—");
        if (v.buffs.length > 0)
          stat(
            "buffs",
            v.buffs
              .map((b) => `${b.templateId} ${Math.ceil(b.remainingMs / 1000)}s`)
              .join(", "),
          );
        body.append(grid);
        if (v.statPoints > 0) {
          const b = document.createElement("button");
          b.type = "button";
          b.className = "primary wide";
          b.dataset.testid = "btn-stats";
          b.textContent = `spend ${v.statPoints} stat point${v.statPoints > 1 ? "s" : ""}`;
          b.addEventListener("click", (e) => {
            e.preventDefault();
            on.press([KEYS.escape, KEYS.stats]);
          });
          body.append(b);
        }
      }
      const quests = document.createElement("div");
      quests.className = "quests";
      if (m.kind === "character") quests.append(text("h", "quests"));
      for (const q of v.quests) {
        const d = text("quest", "");
        d.append(text("t", q.id, "span"));
        d.append(
          text(
            `b q-${q.status}`,
            q.progress
              ? `${q.status} ${q.progress.have}/${q.progress.count}`
              : q.status,
            "span",
          ),
        );
        if (q.giver) d.append(text("s", `from ${q.giver}`, "span"));
        quests.append(d);
      }
      if (v.quests.length === 0) quests.append(text("s", "no quests"));
      body.append(quests);
    } else if (m.lines && m.rows.length === 0) {
      for (const l of m.lines) body.append(text("line", l));
    }
    if (m.rows.length > 0) {
      const list = document.createElement("div");
      list.className = "rows";
      for (const r of m.rows) list.append(rowButton(r, sheets));
      body.append(list);
    }
    root.append(body);
  };
  return {
    get open() {
      return open;
    },
    render(m, sheets) {
      if (!m) {
        if (open) {
          root.hidden = true;
          delete root.dataset.dialog;
          root.removeAttribute("aria-label");
          root.replaceChildren();
          open = false;
          last = "";
        }
        return;
      }
      const sig = JSON.stringify([m, sheets?.view.title ?? null]);
      if (sig !== last) {
        last = sig;
        build(m, sheets);
      }
      if (!open) {
        root.hidden = false;
        open = true;
      }
    },
  };
}
