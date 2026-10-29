// Renders the Claude Code usage card: session + weekly quota bars with
// reset countdowns, breakdown by activity, and extra usage spending & balance.
// Payloads come from the Rust `claude-usage` provider.

import { invoke } from "@tauri-apps/api/core";

export interface UsageWindow {
  utilization: number;
  resets_at: string | null;
}

export interface ExtraUsageData {
  is_enabled: boolean;
  monthly_limit: number | null;
  used: number | null;
  balance: number | null;
  utilization: number | null;
  spend_limit_reached: boolean;
  resets_at: string | null;
}

export interface PrepaidData {
  balance: number;
  active_credit: number | null;
  credit_seen: number;
  credit_added: number;
  tracking_since_ms: number | null;
  paid_this_month: number | null;
  paid_tracked: number;
  auto_reload: boolean;
  reload_threshold: number | null;
  reload_to: number | null;
}

export interface BreakdownItem {
  name: string;
  percent: number;
}

export interface ClaudeUsageData {
  session: UsageWindow | null;
  weekly: UsageWindow | null;
  weekly_opus: UsageWindow | null;
  weekly_sonnet: UsageWindow | null;
  breakdown: BreakdownItem[] | null;
  extra_usage: ExtraUsageData | null;
  prepaid: PrepaidData | null;
  plan: string | null;
}

export interface StatsPayload<T = ClaudeUsageData> {
  ok: boolean;
  data?: T;
  error?: { kind: string; message: string };
  fetched_at: number;
  next_poll_secs: number;
}

// "Spending now" detection, from two cheap signals. Either one stays lit for
// ACTIVE_MS after it was last seen, so the pulse stops 5 minutes after the
// last activity:
//  - usage rises between consecutive polls (60s apart, whole-percent steps),
//    summed over the window for the "+N%" readout;
//  - local Claude Code activity (session-log writes, see watchClaudeActivity),
//    which lights the pulse even before the percentage ticks over.
const ACTIVE_MS = 5 * 60_000;
const RISE_EPSILON = { pct: 0.05, usd: 0.005 };

interface Rise {
  delta: number;
  at: number;
}

interface Track {
  value: number;
  unit: "pct" | "usd";
  rises: Rise[];
}

const tracks = new Map<string, Track>();
let lastObservedAt = 0;

function observe(key: string, value: number, at: number, unit: "pct" | "usd"): void {
  const prev = tracks.get(key);
  if (!prev) {
    tracks.set(key, { value, unit, rises: [] });
    return;
  }
  const delta = value - prev.value;
  let rises = prev.rises.filter((r) => at - r.at < ACTIVE_MS);
  if (delta > RISE_EPSILON[unit]) {
    rises.push({ delta, at });
  } else if (delta < 0) {
    rises = []; // window reset: re-baseline
  }
  tracks.set(key, { value, unit, rises });
}

function observeAll(d: ClaudeUsageData, at: number): void {
  if (at === lastObservedAt) return;
  lastObservedAt = at;
  const windows: [string, UsageWindow | null][] = [
    ["Session (5h)", d.session],
    ["Weekly", d.weekly],
    ["Weekly · Sonnet", d.weekly_sonnet],
    ["Weekly · Opus", d.weekly_opus],
  ];
  for (const [key, w] of windows) {
    if (w) observe(key, w.utilization, at, "pct");
  }
  if (d.extra_usage?.is_enabled && d.extra_usage.used != null) {
    observe("extra", d.extra_usage.used, at, "usd");
  }
}

interface ActiveRise {
  delta: number; // total over the window
  at: number; // when the latest rise was seen
  unit: "pct" | "usd";
}

function activeRise(key: string): ActiveRise | null {
  const t = tracks.get(key);
  const live = t?.rises.filter((r) => Date.now() - r.at < ACTIVE_MS) ?? [];
  if (!t || live.length === 0) return null;
  return { delta: live.reduce((sum, r) => sum + r.delta, 0), at: live[live.length - 1].at, unit: t.unit };
}

function rateHtml(r: ActiveRise, withSep: boolean): string {
  const amount =
    r.unit === "usd" ? `$${r.delta.toFixed(2)}` : `${Number(r.delta.toFixed(1))}%`;
  return `<span class="usage-rate" data-rise-at="${r.at}">▲ +${amount} in last 5m${withSep ? " · " : ""}</span>`;
}

let localActiveAt: number | null = null;

/** Lights the rows while Claude Code is writing session logs. DOM-only, so it never disturbs a render. */
function applyLocalActivity(container: HTMLElement): void {
  const active = localActiveAt != null && Date.now() - localActiveAt < ACTIVE_MS;
  container.querySelectorAll<HTMLElement>(".usage-row").forEach((rowEl, i) => {
    const hasRise = rowEl.querySelector(".usage-rate:not(.usage-rate-local)") !== null;
    rowEl.classList.toggle("burning", active || hasRise);
    if (i > 0) return;
    // The first row carries the text readout when no numeric rise is shown.
    const reset = rowEl.querySelector<HTMLElement>(".usage-reset");
    if (!reset) return;
    reset.querySelector(".usage-rate-local")?.remove();
    if (active && !hasRise) {
      const sep = reset.textContent?.trim() ? " · " : "";
      reset.insertAdjacentHTML(
        "afterbegin",
        `<span class="usage-rate usage-rate-local">● Claude Code active${sep}</span>`,
      );
    }
  });
}

/** Polls the backend for the newest Claude Code session-log write (a directory-metadata read, no network). */
export function watchClaudeActivity(container: HTMLElement): void {
  const poll = async () => {
    try {
      localActiveAt = await invoke<number | null>("claude_activity");
    } catch {
      /* keep the last value; it expires on its own */
    }
    applyLocalActivity(container);
  };
  void poll();
  setInterval(poll, 10_000);
}

let savedBudget: number | null = null;
let budgetLoaded = false;

export async function loadBudget(): Promise<void> {
  if (!budgetLoaded) {
    try {
      savedBudget = await invoke<number | null>("get_budget");
    } catch {
      savedBudget = null;
    }
    budgetLoaded = true;
  }
}

function barColor(utilization: number): string {
  if (utilization >= 90) return "var(--bar-red)";
  if (utilization >= 70) return "var(--bar-amber)";
  return "var(--bar-green)";
}

function countdown(resetsAt: string | null): string {
  if (!resetsAt) return "";
  const date = new Date(resetsAt);
  const ms = date.getTime() - Date.now();
  if (isNaN(ms)) return "";
  if (ms <= 0) return "resetting…";

  const timeStr = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);

  let rel = "";
  if (h >= 48) {
    rel = `resets in ${Math.floor(h / 24)}d ${h % 24}h`;
  } else if (h > 0) {
    rel = `resets in ${h}h ${m}m`;
  } else {
    rel = `resets in ${m}m`;
  }
  return `${rel} <span class="usage-reset-time">(${timeStr})</span>`;
}

function formatMonthlyReset(resetsAt: string | null): string {
  if (!resetsAt) return "Resets monthly";
  const date = new Date(resetsAt);
  const ms = date.getTime() - Date.now();
  if (isNaN(ms)) return "Resets monthly";
  if (ms <= 0) return "Resetting cycle…";

  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const mName = monthNames[date.getMonth()];
  const day = date.getDate();

  const d = Math.floor(ms / (24 * 3_600_000));
  const h = Math.floor((ms % (24 * 3_600_000)) / 3_600_000);

  const rel = d > 0 ? `in ${d}d ${h}h` : `in ${h}h`;
  return `Resets ${mName} ${day} (${rel})`;
}

function row(label: string, w: UsageWindow | null): string {
  if (!w) return "";
  const pct = Math.min(100, Math.max(0, w.utilization));
  const remaining = Math.max(0, 100 - pct);

  let resetHtml = "";
  if (w.resets_at) {
    resetHtml = countdown(w.resets_at);
  } else if (pct <= 0) {
    resetHtml = `<span class="usage-ready">Ready · 100% available</span>`;
  }

  const rise = activeRise(label);
  if (rise) resetHtml = rateHtml(rise, !!resetHtml) + resetHtml;

  return `
    <div class="usage-row${rise ? " burning" : ""}" data-resets="${w.resets_at ?? ""}">
      <div class="usage-labels">
        <span class="usage-name">${label}</span>
        <span class="usage-remaining">${remaining.toFixed(0)}% left</span>
      </div>
      <div class="usage-bar"><div class="usage-fill" style="width:${pct}%;background:${barColor(pct)}"></div></div>
      <div class="usage-reset">${resetHtml}</div>
    </div>`;
}

function renderBreakdown(items: BreakdownItem[] | null | undefined): string {
  if (!items || items.length === 0) return "";
  const chips = items
    .map((item) => `<span class="breakdown-chip">${item.name} <b>${item.percent}%</b></span>`)
    .join("");
  return `<div class="breakdown-chips">${chips}</div>`;
}

function renderExtraUsage(eu: ExtraUsageData | null | undefined): string {
  if (!eu) return "";

  if (!eu.is_enabled) {
    return `
      <div class="spending-section">
        <div class="spending-labels">
          <span class="spending-title">Extra Spending</span>
          <span class="spending-status-muted">Extra Usage: Off</span>
        </div>
      </div>`;
  }

  const spent = eu.used != null ? eu.used : 0;
  const spentFormatted = `$${spent.toFixed(2)}`;
  const effectiveLimit = eu.monthly_limit ?? savedBudget;
  const resetText = formatMonthlyReset(eu.resets_at);
  const rise = activeRise("extra");
  const rate = rise ? rateHtml(rise, false) : "";
  const burning = rise ? " burning" : "";

  if (effectiveLimit != null && effectiveLimit > 0) {
    const limitFormatted = `$${effectiveLimit.toFixed(2)}`;
    const balance = Math.max(0, effectiveLimit - spent);
    const balanceFormatted = `$${balance.toFixed(2)}`;
    const pct = Math.min(100, Math.max(0, (spent / effectiveLimit) * 100));
    const isLimitReached = eu.spend_limit_reached || spent >= effectiveLimit;
    const isCustom = eu.monthly_limit == null && savedBudget != null;

    let badge = "";
    if (isLimitReached) {
      badge = `<span class="spending-badge badge-limit">Limit Reached</span>`;
    } else if (pct >= 80) {
      badge = `<span class="spending-badge badge-warning">${pct.toFixed(0)}% used</span>`;
    }

    return `
      <div class="spending-section ${isLimitReached ? "limit-reached" : ""}${burning}">
        <div class="spending-labels">
          <div class="spending-left">
            <span class="spending-title">Extra Spending</span>
            ${badge}
          </div>
          <div class="spending-right">
            <span class="spending-spent">${spentFormatted}</span>
            <span class="spending-limit ${isCustom ? "clickable-budget" : ""}" title="${isCustom ? "Custom budget (click to edit)" : "Account monthly limit"}">/ ${limitFormatted}</span>
          </div>
        </div>
        <div class="usage-bar">
          <div class="usage-fill" style="width:${pct}%;background:${isLimitReached ? "var(--bar-red)" : barColor(pct)}"></div>
        </div>
        <div class="spending-footer">
          <span class="spending-balance">${balanceFormatted} balance left${rate}</span>
          <span class="spending-reset">${resetText}</span>
        </div>
      </div>`;
  }

  // Enabled, but no monthly limit set on account
  return `
    <div class="spending-section${burning}">
      <div class="spending-labels">
        <div class="spending-left">
          <span class="spending-title">Extra Spending</span>
          <span class="spending-badge badge-uncapped">Uncapped</span>
        </div>
        <div class="spending-right">
          <span class="spending-spent">${spentFormatted}</span>
          <button class="btn-set-budget" title="Set a monthly spend budget to track remaining balance">+ set limit</button>
        </div>
      </div>
      <div class="spending-footer">
        <span class="spending-uncapped-text">Pay-as-you-go${rate}</span>
        <span class="spending-reset">${resetText}</span>
      </div>
    </div>`;
}

function renderPrepaid(p: PrepaidData | null | undefined): string {
  if (!p) return "";

  const money = (n: number) => `$${n.toFixed(2)}`;
  const since =
    p.tracking_since_ms != null
      ? new Date(p.tracking_since_ms).toLocaleDateString([], { month: "short", day: "numeric" })
      : null;

  const tips: string[] = [];
  if (since) {
    tips.push(
      `Credit seen since ${since}: ${money(p.credit_seen)} (${money(p.credit_added)} added since tracking began)`,
    );
  }
  if (p.auto_reload && p.reload_threshold != null && p.reload_to != null) {
    tips.push(`Auto-reload to ${money(p.reload_to)} below ${money(p.reload_threshold)}`);
  }
  const title = tips.length ? ` title="${tips.join(" · ")}"` : "";

  const active =
    p.active_credit != null && p.active_credit > 0
      ? `<span class="prepaid-total">of ${money(p.active_credit)} active</span>`
      : "";

  const paid =
    p.paid_this_month != null
      ? `
    <div class="prepaid-line prepaid-paid" title="Dollars actually paid for credit bundles (bundles are discounted, so this is less than the credit received). Tracked total sums every month seen${since ? ` since ${since}` : ""}.">
      <span class="prepaid-label">Paid this month</span>
      <span class="prepaid-amount"><b>${money(p.paid_this_month)}</b> <span class="prepaid-total">· ${money(p.paid_tracked)} tracked</span></span>
    </div>`
      : "";

  return `
    <div class="prepaid-line"${title}>
      <span class="prepaid-label">Prepaid credits</span>
      <span class="prepaid-amount"><b>${money(p.balance)}</b> left ${active}</span>
    </div>${paid}`;
}

export function renderClaudeUsage(container: HTMLElement, payload: StatsPayload): void {
  if (!payload.ok) {
    if (!container.querySelector(".usage-row") && !container.querySelector(".spending-section")) {
      container.innerHTML = `<div class="card-error">${payload.error?.message ?? "Unknown error"}</div>`;
    }
    return;
  }

  const d = payload.data!;
  observeAll(d, payload.fetched_at);

  let html = row("Session (5h)", d.session);
  html += row("Weekly", d.weekly);
  if (d.breakdown) {
    html += renderBreakdown(d.breakdown);
  }
  if (d.weekly_sonnet) html += row("Weekly · Sonnet", d.weekly_sonnet);
  if (d.weekly_opus) html += row("Weekly · Opus", d.weekly_opus);

  const spendingHtml = renderExtraUsage(d.extra_usage);
  if (spendingHtml) {
    html += spendingHtml;
  }
  html += renderPrepaid(d.prepaid);

  container.innerHTML = html || `<div class="card-error">No usage data returned</div>`;

  // Attach handlers for setting/editing budget
  container.querySelectorAll(".btn-set-budget, .clickable-budget").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const current = savedBudget ? String(savedBudget) : "";
      const val = window.prompt("Set monthly spending budget in USD (e.g. 300, or empty for uncapped):", current);
      if (val !== null) {
        const num = parseFloat(val.trim());
        const newBudget = !isNaN(num) && num > 0 ? num : null;
        await invoke("set_budget", { budget: newBudget });
        savedBudget = newBudget;
        renderClaudeUsage(container, payload);
      }
    });
  });
  applyLocalActivity(container);
}

/** Refreshes the ticking countdown texts without a new fetch. */
export function tickCountdowns(container: HTMLElement): void {
  container.querySelectorAll<HTMLElement>(".usage-row").forEach((rowEl) => {
    const resets = rowEl.dataset.resets || null;
    const el = rowEl.querySelector<HTMLElement>(".usage-reset");
    if (el && resets) {
      const rate = el.querySelector<HTMLElement>(".usage-rate:not(.usage-rate-local)");
      el.innerHTML = (rate ? rate.outerHTML : "") + countdown(resets);
    }
  });

  // Let the "spending now" pulse and readout fade once the last rise is stale.
  container.querySelectorAll<HTMLElement>(".usage-rate:not(.usage-rate-local)").forEach((rate) => {
    if (Date.now() - Number(rate.dataset.riseAt) < ACTIVE_MS) return;
    rate.closest(".usage-row, .spending-section")?.classList.remove("burning");
    rate.remove();
  });
  applyLocalActivity(container);
}
