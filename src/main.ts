import { invoke } from "@tauri-apps/api/core";
import { listen, emit } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  renderClaudeUsage,
  tickCountdowns,
  loadBudget,
  watchClaudeActivity,
  type StatsPayload,
} from "./cards/claude-usage";
import { renderOctopusAgile, tickAgile } from "./cards/octopus-agile";
import { createFrame, readLayout, wireInteractions, type CardFrame, type Layout } from "./card-frame";

// Card registry: provider id -> how to show it. Add new stats here. Each card
// is drawn inside its own box (see card-frame.ts); `render` fills the body,
// `meta` is the small badge on the right of the title row, `tick` re-evaluates
// time-dependent text between polls. Default on-screen order is registry order.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyPayload = StatsPayload<any>;
interface CardDef {
  title: string;
  render: (body: HTMLElement, payload: AnyPayload) => void;
  meta?: (payload: AnyPayload) => string;
  tick?: (body: HTMLElement) => void;
}
const CARDS: Record<string, CardDef> = {
  "claude-usage": {
    title: "Claude",
    render: renderClaudeUsage,
    meta: (p) => (p.data?.plan ? String(p.data.plan) : ""),
    tick: tickCountdowns,
  },
  "octopus-agile": {
    title: "Octopus Agile",
    render: renderOctopusAgile,
    meta: (p) => (p.data?.region ? `Region ${p.data.region}` : ""),
    tick: tickAgile,
  },
};

const frames: Record<string, CardFrame> = {};
const lastFetched: Record<string, number> = {};

function adjustWindowSize(): void {
  requestAnimationFrame(() => {
    const widget = document.querySelector<HTMLElement>("#widget");
    if (!widget) return;
    const height = Math.ceil(widget.getBoundingClientRect().height);
    if (height > 60) {
      invoke("resize_window", { height });
    }
  });
}

function saveLayout(): void {
  const layout = readLayout(document.querySelector<HTMLElement>("#cards")!);
  invoke("set_layout", { layout }).catch(() => {});
}

/** Builds each card's box in the saved order (unknown/new ids fall back to registry order). */
async function buildFrames(): Promise<void> {
  let layout: Layout = { order: [], collapsed: [] };
  try {
    layout = await invoke<Layout>("get_layout");
  } catch {
    /* no saved layout */
  }
  const ids = Object.keys(CARDS);
  const ordered = [...layout.order.filter((id) => id in CARDS), ...ids.filter((id) => !layout.order.includes(id))];
  const container = document.querySelector<HTMLElement>("#cards")!;
  for (const id of ordered) {
    const frame = createFrame(id, CARDS[id].title, layout.collapsed.includes(id));
    wireInteractions(frame.card, saveLayout);
    container.appendChild(frame.card);
    frames[id] = frame;
  }
}

function updateStatus(): void {
  const statusEl = document.querySelector<HTMLElement>("#widget-status")!;
  const ts = Object.values(lastFetched);
  if (ts.length === 0) {
    statusEl.textContent = "loading…";
    return;
  }
  const oldest = Math.min(...ts);
  const ageMin = Math.floor((Date.now() - oldest) / 60_000);
  statusEl.textContent =
    ageMin <= 1 ? "updated just now" : `updated ${ageMin}m ago`;
  statusEl.classList.toggle("stale", ageMin >= 15);
}

function handlePayload(id: string, payload: AnyPayload): void {
  const def = CARDS[id];
  const frame = frames[id];
  if (!def || !frame) return;
  def.render(frame.body, payload);
  frame.card.hidden = false;
  if (payload.ok) {
    frame.meta.textContent = def.meta?.(payload) ?? "";
    lastFetched[id] = payload.fetched_at;
  }
  if (!payload.ok && payload.error) {
    const statusEl = document.querySelector<HTMLElement>("#widget-status")!;
    statusEl.textContent = payload.error.message;
    statusEl.classList.add("stale");
    adjustWindowSize();
    return;
  }
  updateStatus();
  adjustWindowSize();
}

// Block user-triggered webview zoom (Ctrl+wheel / pinch / Ctrl+±).
window.addEventListener("wheel", (e) => { if (e.ctrlKey) e.preventDefault(); }, { passive: false });
window.addEventListener("keydown", (e) => {
  if (e.ctrlKey && ["+", "-", "=", "0"].includes(e.key)) e.preventDefault();
});

window.addEventListener("DOMContentLoaded", async () => {
  await loadBudget();

  const widgetEl = document.querySelector<HTMLElement>("#widget");
  if (widgetEl && typeof ResizeObserver !== "undefined") {
    const ro = new ResizeObserver(() => {
      adjustWindowSize();
    });
    ro.observe(widgetEl);
  }

  // Create every box up front so on-screen order follows the saved layout, not
  // whichever provider answers first.
  await buildFrames();
  watchClaudeActivity(frames["claude-usage"].body);

  for (const id of Object.keys(CARDS)) {
    await listen<AnyPayload>(`stats://${id}`, (e) => handlePayload(id, e.payload));
    const cached = await invoke<AnyPayload | null>("get_stats", { providerId: id });
    if (cached) handlePayload(id, cached);
  }
  await emit("frontend-ready");

  document.querySelector("#btn-refresh")?.addEventListener("click", () => {
    invoke("refresh_now", { providerId: null });
  });
  document.querySelector("#btn-close")?.addEventListener("click", () => {
    getCurrentWindow().close();
  });

  setInterval(() => {
    for (const [id, def] of Object.entries(CARDS)) def.tick?.(frames[id].body);
    updateStatus();
  }, 30_000);
});
