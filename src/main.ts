import { invoke } from "@tauri-apps/api/core";
import { listen, emit } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { renderClaudeUsage, tickCountdowns, type StatsPayload } from "./cards/claude-usage";

// Card registry: provider id -> render function. Add new stats here.
type CardRenderer = (container: HTMLElement, payload: StatsPayload) => void;
const CARDS: Record<string, CardRenderer> = {
  "claude-usage": renderClaudeUsage,
};

const lastFetched: Record<string, number> = {};

function cardContainer(id: string): HTMLElement {
  let el = document.querySelector<HTMLElement>(`[data-card="${id}"]`);
  if (!el) {
    el = document.createElement("section");
    el.className = "card";
    el.dataset.card = id;
    document.querySelector("#cards")!.appendChild(el);
  }
  return el;
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

function handlePayload(id: string, payload: StatsPayload): void {
  const renderer = CARDS[id];
  if (!renderer) return;
  renderer(cardContainer(id), payload);
  if (payload.ok) lastFetched[id] = payload.fetched_at;
  if (!payload.ok && payload.error) {
    const statusEl = document.querySelector<HTMLElement>("#widget-status")!;
    statusEl.textContent = payload.error.message;
    statusEl.classList.add("stale");
    return;
  }
  updateStatus();
}

window.addEventListener("DOMContentLoaded", async () => {
  for (const id of Object.keys(CARDS)) {
    await listen<StatsPayload>(`stats://${id}`, (e) => handlePayload(id, e.payload));
    const cached = await invoke<StatsPayload | null>("get_stats", { providerId: id });
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
    for (const id of Object.keys(CARDS)) tickCountdowns(cardContainer(id));
    updateStatus();
  }, 30_000);
});
