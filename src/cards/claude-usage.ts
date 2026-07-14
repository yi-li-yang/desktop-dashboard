// Renders the Claude Code usage card: session + weekly quota bars with
// reset countdowns. Payloads come from the Rust `claude-usage` provider.

interface UsageWindow {
  utilization: number;
  resets_at: string | null;
}

interface ClaudeUsageData {
  session: UsageWindow | null;
  weekly: UsageWindow | null;
  weekly_opus: UsageWindow | null;
  weekly_sonnet: UsageWindow | null;
  plan: string | null;
}

export interface StatsPayload {
  ok: boolean;
  data?: ClaudeUsageData;
  error?: { kind: string; message: string };
  fetched_at: number;
  next_poll_secs: number;
}

function barColor(utilization: number): string {
  if (utilization >= 90) return "var(--bar-red)";
  if (utilization >= 70) return "var(--bar-amber)";
  return "var(--bar-green)";
}

function countdown(resetsAt: string | null): string {
  if (!resetsAt) return "";
  const ms = new Date(resetsAt).getTime() - Date.now();
  if (isNaN(ms)) return "";
  if (ms <= 0) return "resetting…";
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  if (h >= 48) return `resets in ${Math.floor(h / 24)}d ${h % 24}h`;
  if (h > 0) return `resets in ${h}h ${m}m`;
  return `resets in ${m}m`;
}

function row(label: string, w: UsageWindow | null): string {
  if (!w) return "";
  const pct = Math.min(100, Math.max(0, w.utilization));
  const remaining = Math.max(0, 100 - pct);
  return `
    <div class="usage-row" data-resets="${w.resets_at ?? ""}">
      <div class="usage-labels">
        <span class="usage-name">${label}</span>
        <span class="usage-remaining">${remaining.toFixed(0)}% left</span>
      </div>
      <div class="usage-bar"><div class="usage-fill" style="width:${pct}%;background:${barColor(pct)}"></div></div>
      <div class="usage-reset">${countdown(w.resets_at)}</div>
    </div>`;
}

export function renderClaudeUsage(container: HTMLElement, payload: StatsPayload): void {
  const planEl = document.querySelector<HTMLElement>("#widget-plan");

  if (!payload.ok) {
    // Keep last good data visible; only show full-card error if we have none.
    if (!container.querySelector(".usage-row")) {
      container.innerHTML = `<div class="card-error">${payload.error?.message ?? "Unknown error"}</div>`;
    }
    return;
  }

  const d = payload.data!;
  if (planEl && d.plan) planEl.textContent = String(d.plan);

  const html =
    row("Session (5h)", d.session) +
    row("Weekly", d.weekly) +
    row("Weekly · Opus", d.weekly_opus);
  container.innerHTML = html || `<div class="card-error">No usage data returned</div>`;
}

/** Refreshes the ticking countdown texts without a new fetch. */
export function tickCountdowns(container: HTMLElement): void {
  container.querySelectorAll<HTMLElement>(".usage-row").forEach((rowEl) => {
    const resets = rowEl.dataset.resets || null;
    const el = rowEl.querySelector<HTMLElement>(".usage-reset");
    if (el) el.textContent = countdown(resets);
  });
}
