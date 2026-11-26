// Hover explanations. An element with `data-tip` (HTML, built by the card
// that drew it) shows that text in one panel shared by the whole widget. The
// panel sits under the hovered element, or over it when the window has no room
// below: the Tauri window is only as tall as the widget, so a panel outside
// it would be cut off. Native `title` tooltips stay for buttons.

const DELAY_MS = 250;
const GAP = 4;

/** Builds a tip: a title, then short "key: text" rows. Pass already-escaped HTML. */
export function tipHtml(title: string, rows: [string, string][]): string {
  const body = rows
    .map(([k, v]) => `<div class="tip-row"><span class="tip-key">${k}</span><span>${v}</span></div>`)
    .join("");
  return `<div class="tip-title">${title}</div>${body}`;
}

export function initTooltips(): void {
  const tip = document.createElement("div");
  tip.className = "tip";
  tip.setAttribute("role", "tooltip");
  tip.hidden = true;
  document.body.appendChild(tip);

  let current: HTMLElement | null = null;
  let timer: number | undefined;

  const hide = () => {
    window.clearTimeout(timer);
    current = null;
    tip.hidden = true;
  };

  const show = (el: HTMLElement) => {
    tip.innerHTML = el.dataset.tip ?? "";
    tip.hidden = false;
    const widget = document.querySelector<HTMLElement>("#widget")!.getBoundingClientRect();
    const target = el.getBoundingClientRect();
    tip.style.left = `${widget.left + GAP}px`;
    tip.style.width = `${widget.width - 2 * GAP}px`;
    const h = tip.offsetHeight;
    let top = target.bottom + GAP;
    if (top + h > window.innerHeight - GAP) top = target.top - h - GAP;
    tip.style.top = `${Math.max(GAP, top)}px`;
  };

  document.addEventListener("mouseover", (e) => {
    const t = e.target as Element;
    // Buttons keep their own native tooltip; dragging a card shows none.
    const el = t.closest("button") || document.querySelector(".card.dragging")
      ? null
      : t.closest<HTMLElement>("[data-tip]");
    if (el === current) return;
    hide();
    if (!el) return;
    current = el;
    timer = window.setTimeout(() => show(el), DELAY_MS);
  });
  document.documentElement.addEventListener("mouseleave", hide);
  window.addEventListener("blur", hide);
  // A re-render replaces the hovered element; drop the stale panel with it.
  new MutationObserver(() => {
    if (current && !current.isConnected) hide();
  }).observe(document.querySelector("#cards")!, { childList: true, subtree: true });
}
