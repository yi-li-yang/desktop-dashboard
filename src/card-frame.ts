// The box around every card: a title row (click to collapse/expand, drag to
// reorder) and a body the card's renderer fills. Renderers never see the frame.

export interface Layout {
  order: string[];
  collapsed: string[];
}

export interface CardFrame {
  card: HTMLElement;
  body: HTMLElement;
  meta: HTMLElement;
}

const DRAG_THRESHOLD_PX = 4;

export function createFrame(id: string, title: string, collapsed: boolean): CardFrame {
  const card = document.createElement("section");
  card.className = "card";
  card.dataset.card = id;
  card.hidden = true; // shown once the first payload arrives
  card.classList.toggle("collapsed", collapsed);
  card.innerHTML = `
    <div class="card-head" title="Click to collapse, drag to reorder">
      <span class="card-chevron">▾</span>
      <span class="card-title"></span>
      <span class="card-meta"></span>
    </div>
    <div class="card-body"></div>`;
  card.querySelector<HTMLElement>(".card-title")!.textContent = title;
  return {
    card,
    body: card.querySelector<HTMLElement>(".card-body")!,
    meta: card.querySelector<HTMLElement>(".card-meta")!,
  };
}

/** Snapshot of the current arrangement, for saving. */
export function readLayout(cards: HTMLElement): Layout {
  const all = Array.from(cards.querySelectorAll<HTMLElement>(":scope > .card"));
  return {
    order: all.map((c) => c.dataset.card!),
    collapsed: all.filter((c) => c.classList.contains("collapsed")).map((c) => c.dataset.card!),
  };
}

function visibleSibling(el: HTMLElement, dir: "previousElementSibling" | "nextElementSibling"): HTMLElement | null {
  let s = el[dir] as HTMLElement | null;
  while (s && s.hidden) s = s[dir] as HTMLElement | null;
  return s;
}

const midY = (el: HTMLElement) => {
  const r = el.getBoundingClientRect();
  return r.top + r.height / 2;
};

/** Moves `card` past any sibling whose midpoint the pointer has crossed. */
function reorder(card: HTMLElement, y: number): void {
  const parent = card.parentElement;
  if (!parent) return;
  let prev = visibleSibling(card, "previousElementSibling");
  while (prev && y < midY(prev)) {
    parent.insertBefore(card, prev);
    prev = visibleSibling(card, "previousElementSibling");
  }
  let next = visibleSibling(card, "nextElementSibling");
  while (next && y > midY(next)) {
    parent.insertBefore(next, card);
    next = visibleSibling(card, "nextElementSibling");
  }
}

/**
 * Click the title row to collapse/expand; press and drag it to reorder.
 * Built on pointer events: HTML5 drag-and-drop is unreliable in a frameless
 * Tauri window.
 */
export function wireInteractions(card: HTMLElement, onChange: () => void): void {
  const head = card.querySelector<HTMLElement>(".card-head")!;
  let pressed = false;
  let dragging = false;
  let startY = 0;

  const finish = (e: PointerEvent, commit: boolean) => {
    if (!pressed) return;
    pressed = false;
    try {
      head.releasePointerCapture(e.pointerId);
    } catch {
      /* capture already gone */
    }
    card.classList.remove("dragging");
    if (!commit) return;
    if (!dragging) card.classList.toggle("collapsed");
    onChange();
  };

  head.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    pressed = true;
    dragging = false;
    startY = e.clientY;
    head.setPointerCapture(e.pointerId);
  });
  head.addEventListener("pointermove", (e) => {
    if (!pressed) return;
    if (!dragging) {
      if (Math.abs(e.clientY - startY) < DRAG_THRESHOLD_PX) return;
      dragging = true;
      card.classList.add("dragging");
    }
    reorder(card, e.clientY);
  });
  head.addEventListener("pointerup", (e) => finish(e, true));
  head.addEventListener("pointercancel", (e) => finish(e, false));
}
