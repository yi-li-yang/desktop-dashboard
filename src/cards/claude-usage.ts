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

  return `
    <div class="usage-row" data-resets="${w.resets_at ?? ""}">
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
      <div class="spending-section ${isLimitReached ? "limit-reached" : ""}">
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
          <span class="spending-balance">${balanceFormatted} balance left</span>
          <span class="spending-reset">${resetText}</span>
        </div>
      </div>`;
  }

  // Enabled, but no monthly limit set on account
  return `
    <div class="spending-section">
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
        <span class="spending-uncapped-text">Pay-as-you-go</span>
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
}

/** Refreshes the ticking countdown texts without a new fetch. */
export function tickCountdowns(container: HTMLElement): void {
  container.querySelectorAll<HTMLElement>(".usage-row").forEach((rowEl) => {
    const resets = rowEl.dataset.resets || null;
    const el = rowEl.querySelector<HTMLElement>(".usage-reset");
    if (el && resets) el.innerHTML = countdown(resets);
  });
}
