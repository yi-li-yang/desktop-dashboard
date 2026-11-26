// Renders the Claude Code usage card: session + weekly quota bars with
// reset countdowns, breakdown by activity, and extra usage spending & balance.
// Payloads come from the Rust `claude-usage` provider.

import { invoke } from "../ipc";
import { ICON } from "../icons";
import { tipHtml } from "../tooltip";
import { monoNumbers } from "../num";

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

/** A model- or surface-scoped weekly limit, e.g. Fable. */
export interface ScopedLimit {
  name: string;
  utilization: number;
  resets_at: string | null;
  allowance_pct: number | null; // share of the weekly limit it may use
  used_pct_of_weekly?: number | null; // how much of the weekly limit it has used
}

export interface FreeReset {
  label: string;
  kind: string; // "full" | "session" | "weekly" | "Fable"
  left: number;
  usable_now: boolean;
  ends_at: string | null;
}

export interface FreeCredit {
  label: string;
  left: number | null;
  total: number | null;
  utilization: number | null;
  resets_at: string | null; // a credit that refills, e.g. weekly
  ends_at: string | null; // when the credit or its offer ends
}

export interface PrepaidData {
  balance: number;
  free_credits?: FreeCredit[];
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
  scoped?: ScopedLimit[] | null;
  breakdown: BreakdownItem[] | null;
  free_resets?: FreeReset[] | null;
  free_credits?: FreeCredit[] | null;
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
    ...scopedRows(d).map((s): [string, UsageWindow] => [`Weekly · ${s.name}`, s]),
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
  return `<span class="usage-rate" data-rise-at="${r.at}">+${amount} in last 5m${withSep ? " · " : ""}</span>`;
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
        `<span class="usage-rate usage-rate-local">Claude Code active${sep}</span>`,
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

// Quota used: sky while there is room, ochre from 70%, rust from 90%. The
// "% left" number beside each bar says the same thing without colour.
function barColor(utilization: number): string {
  if (utilization >= 90) return "var(--data-rust)";
  if (utilization >= 70) return "var(--data-ochre)";
  return "var(--data-sky)";
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

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function shortDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "" : `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

const money = (n: number) => `$${n.toFixed(2)}`;

/** Scoped weekly limits that the named weekly_sonnet / weekly_opus windows don't already show. */
function scopedRows(d: ClaudeUsageData): ScopedLimit[] {
  return (d.scoped ?? []).filter((s) => {
    const n = s.name.toLowerCase();
    return !((n === "sonnet" && d.weekly_sonnet) || (n === "opus" && d.weekly_opus));
  });
}

/**
 * One quota bar. `sub` replaces the ticking reset countdown with fixed text
 * (used when a row shares the weekly reset, so the same countdown isn't repeated).
 */
function row(label: string, w: UsageWindow | null, opts: { sub?: string; tip?: string } = {}): string {
  if (!w) return "";
  const pct = Math.min(100, Math.max(0, w.utilization));
  const remaining = Math.max(0, 100 - pct);

  let resetHtml = "";
  if (opts.sub) {
    resetHtml = opts.sub;
  } else if (w.resets_at) {
    resetHtml = countdown(w.resets_at);
  } else if (pct <= 0) {
    resetHtml = `<span class="usage-ready">Ready · 100% available</span>`;
  }

  const rise = activeRise(label);
  if (rise) resetHtml = rateHtml(rise, !!resetHtml) + resetHtml;

  return `
    <div class="usage-row${rise ? " burning" : ""}" data-resets="${opts.sub ? "" : (w.resets_at ?? "")}"${opts.tip ? ` data-tip="${escapeHtml(opts.tip)}"` : ""}>
      <div class="usage-labels">
        <span class="usage-name">${label}</span>
        <span class="usage-remaining"><b>${remaining.toFixed(0)}%</b> left</span>
      </div>
      <div class="usage-bar"><div class="usage-fill" style="width:${pct}%;--fill:${barColor(pct)}"></div></div>
      <div class="usage-reset">${resetHtml}</div>
    </div>`;
}

function renderBreakdown(items: BreakdownItem[] | null | undefined): string {
  if (!items || items.length === 0) return "";
  const chips = items
    .map((item) => `<span class="breakdown-chip">${item.name} <b>${item.percent}%</b></span>`)
    .join("");
  const tip = tipHtml("Where this week's use came from", [
    ["Counts", "Share of Weekly use, by app."],
  ]);
  return `<div class="breakdown-chips" data-tip="${escapeHtml(tip)}">${chips}</div>`;
}

function renderExtraUsage(eu: ExtraUsageData | null | undefined): string {
  if (!eu) return "";

  if (!eu.is_enabled) {
    const spentOff = eu.used != null ? `$${eu.used.toFixed(2)} spent this month` : "Spent this month: unknown";
    return `
      <div class="spending-section">
        <div class="spending-labels">
          <span class="spending-title">Extra Spending</span>
          <button class="spending-status-muted edit-limit" title="Change usage credits and the monthly limit">Extra Usage: Off ${ICON.pencil}</button>
        </div>
        <div class="spending-footer">
          <span class="spending-uncapped-text">${spentOff}</span>
          ${settingsButton()}
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
            ${isCustom
              ? `<span class="spending-limit clickable-budget" title="Custom budget (click to edit)">/ ${limitFormatted}</span>`
              : `<button class="spending-limit edit-limit" title="Change the account's monthly limit">/ ${limitFormatted} ${ICON.pencil}</button>`}
          </div>
        </div>
        <div class="usage-bar">
          <div class="usage-fill" style="width:${pct}%;--fill:${isLimitReached ? "var(--data-rust)" : barColor(pct)}"></div>
        </div>
        <div class="spending-footer">
          <span class="spending-balance">${balanceFormatted} balance left${rate}</span>
          <span class="spending-reset">${resetText}</span>
        </div>
        <div class="spending-footer">${settingsButton()}</div>
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
          <button class="btn-set-budget" title="Set a monthly spend budget to track remaining balance">set limit</button>
        </div>
      </div>
      <div class="spending-footer">
        <span class="spending-uncapped-text">Pay-as-you-go${rate}</span>
        <span class="spending-reset">${resetText}</span>
      </div>
      <div class="spending-footer">${settingsButton()}</div>
    </div>`;
}

// ---- Usage settings
// The pencil spots (the limit, "Extra Usage: Off", "Change limit") open
// claude.ai's usage page in the browser. The dashboard never changes the account.

function settingsButton(): string {
  return `<button class="btn-usage-settings" title="Open claude.ai usage settings: switch usage credits on or off and set the monthly limit">${ICON.pencil} Change limit</button>`;
}

function wireUsageSettings(container: HTMLElement): void {
  const open = async (e: Event) => {
    e.stopPropagation();
    try {
      await invoke("open_usage_settings");
    } catch (err) {
      window.alert(String(err));
      return;
    }
    // Re-read the account as soon as the user comes back from the browser.
    window.addEventListener(
      "focus",
      () => void invoke("refresh_now", { providerId: "claude-usage" }),
      { once: true },
    );
  };
  container.querySelectorAll(".btn-usage-settings, .edit-limit").forEach((el) => el.addEventListener("click", open));
}

/** A one-line "label · value" pair; the label truncates so the value never wraps. */
function kv(label: string, value: string, opts: { tip?: string; cls?: string } = {}): string {
  return `
    <div class="kv-line${opts.cls ? ` ${opts.cls}` : ""}"${opts.tip ? ` data-tip="${escapeHtml(opts.tip)}"` : ""}>
      <span class="kv-label">${label}</span>
      <span class="kv-value">${value}</span>
    </div>`;
}

// ---- Hover explanations: what each limit counts, when it resets, and what
// happens when it runs out. Shown by tooltip.ts.

const ALL_SURFACES = "Claude Code, Cowork, claude.ai and the apps";

/** "Monday at 22:00" for a weekly reset time. */
function weeklyWhen(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "week";
  const day = d.toLocaleDateString("en-GB", { weekday: "long" });
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return `${day} at ${time}`;
}

/** Tip for a weekly limit on one model (Sonnet, Opus, Fable). `name` is escaped HTML. */
function modelTip(name: string, allowance: number | null, usedOfWeekly: number | null): string {
  const rows: [string, string][] = [
    ["Counts", `Only ${name}, in every app. Also counts toward Weekly${allowance != null ? ` (max ${allowance}% of it)` : ""}.`],
  ];
  if (allowance != null && usedOfWeekly != null) {
    rows.push(["Used", `${usedOfWeekly}% of Weekly, of its ${allowance}%.`]);
  }
  rows.push(["Resets", "With Weekly."]);
  rows.push(["At limit", `${name} waits; other models carry on.`]);
  return tipHtml(`Weekly · ${name}`, rows);
}

function freeResetsTip(resets: FreeReset[]): string {
  const kinds = new Set(resets.map((r) => r.kind));
  const rows: [string, string][] = [];
  if (kinds.has("full")) rows.push(["Full", "Refills session and weekly now. Reset day unchanged."]);
  if (kinds.has("Fable")) rows.push(["Fable", "Frees Fable's use this week, refills the session."]);
  if (kinds.has("session")) rows.push(["Session", "Refills the 5-hour session limit."]);
  if (kinds.has("weekly")) rows.push(["Weekly", "Refills the weekly limit."]);
  rows.push(["Use", "/limit-reset in Claude Code. One use each."]);
  rows.push([
    "Use by",
    resets
      .filter((r) => r.ends_at)
      .map((r) => `${r.left} ${r.kind}: ${shortDate(r.ends_at)}`)
      .join(" · "),
  ]);
  return tipHtml("Free resets", rows);
}

function spendingTip(eu: ExtraUsageData | null | undefined): string {
  return tipHtml("Extra spending", [
    ["Counts", "Use past plan limits, paid from usage credits."],
    ["Now", eu?.is_enabled ? "On: carries on, up to the monthly limit." : "Off: stops at a limit until it resets."],
    ["Resets", "Spend total restarts monthly."],
  ]);
}

/** Free limit resets and free credit programs, in one section. */
function renderFree(d: ClaudeUsageData): string {
  let html = "";

  const resets = d.free_resets ?? [];
  if (resets.length) {
    const total = resets.reduce((n, r) => n + r.left, 0);
    // "1 full · 3 Fable": counts by kind, full resets first.
    const byKind = new Map<string, number>();
    for (const r of resets) byKind.set(r.kind, (byKind.get(r.kind) ?? 0) + r.left);
    const kinds = [...byKind.entries()]
      .sort(([a], [b]) => (a === "full" ? -1 : b === "full" ? 1 : 0))
      .map(([k, n]) => `${n} ${k}`)
      .join(" · ");
    const firstEnd = resets
      .map((r) => r.ends_at)
      .filter((e): e is string => !!e)
      .sort((a, b) => Date.parse(a) - Date.parse(b))[0];
    const tip = freeResetsTip(resets);
    html += kv("Free resets", `<b>${total}</b> left`, { tip, cls: "kv-head" });
    html += `<div class="kv-sub">${kinds}${firstEnd ? ` · next expires ${shortDate(firstEnd)}` : ""}</div>`;
  }

  const credits = [...(d.free_credits ?? []), ...(d.prepaid?.free_credits ?? [])];
  for (const c of credits) {
    const value =
      c.left != null
        ? `<b>${money(c.left)}</b> left`
        : c.utilization != null
          ? `<b>${Math.max(0, 100 - c.utilization).toFixed(0)}%</b> left`
          : "";
    const of = c.total != null && c.left != null ? ` of ${money(c.total)}` : "";
    html += kv(escapeHtml(c.label), value, {
      tip: tipHtml(escapeHtml(c.label), [
        ["Counts", "Free credit; used before your plan limits where it applies."],
        ...(c.left != null ? ([["Left", `${money(c.left)}${of}`]] as [string, string][]) : []),
        ...(c.resets_at ? ([["Resets", `${weeklyWhen(c.resets_at)}; unused credit lapses.`]] as [string, string][]) : []),
        ...(c.ends_at ? ([["Ends", shortDate(c.ends_at)]] as [string, string][]) : []),
      ]),
    });
  }

  return html ? `<div class="card-section">${html}</div>` : "";
}

/** Prepaid credit: the usable total, and what was paid for bundles this month. */
function renderPrepaid(p: PrepaidData | null | undefined): string {
  if (!p) return "";
  const reload =
    p.auto_reload && p.reload_threshold != null && p.reload_to != null
      ? `Auto-reload to ${money(p.reload_to)} below ${money(p.reload_threshold)}`
      : undefined;
  let html = kv("Prepaid credits", `<b>${money(p.balance)}</b>`, {
    tip: tipHtml("Prepaid credits", [
      ["Counts", "Credit bought ahead; pays for extra usage."],
      ["Shows", "The whole spendable balance."],
      ...(reload ? ([["Reload", reload]] as [string, string][]) : []),
    ]),
  });
  if (p.paid_this_month != null) {
    html += kv("Paid this month", `<b>${money(p.paid_this_month)}</b>`, {
      tip: tipHtml("Paid this month", [
        ["Counts", "Paid for credit bundles this month."],
        ["Note", "Bundles are discounted: more credit than you pay."],
      ]),
    });
  }
  return `<div class="prepaid-block">${html}</div>`;
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

  const blocked = d.extra_usage?.is_enabled
    ? "Usage credits take over, up to the monthly limit."
    : "Claude waits for the reset, or use a free reset.";
  let html = row("Session (5h)", d.session, {
    tip: tipHtml("Session (5h)", [
      ["Counts", `All use: ${ALL_SURFACES}. Every model.`],
      ["Resets", "5 hours after the session's first message."],
      ["At limit", blocked],
    ]),
  });
  html += row("Weekly", d.weekly, {
    tip: tipHtml("Weekly", [
      ["Counts", `All use: ${ALL_SURFACES}. Every model, Fable and Sonnet too.`],
      ["Resets", d.weekly?.resets_at ? `Every ${weeklyWhen(d.weekly.resets_at)}.` : "Once a week."],
      ["At limit", blocked],
    ]),
  });
  if (d.breakdown) {
    html += renderBreakdown(d.breakdown);
  }
  if (d.weekly_sonnet) html += row("Weekly · Sonnet", d.weekly_sonnet, { tip: modelTip("Sonnet", null, null) });
  if (d.weekly_opus) html += row("Weekly · Opus", d.weekly_opus, { tip: modelTip("Opus", null, null) });
  for (const s of scopedRows(d)) {
    // A scoped limit resets with the weekly one; say how much of it it may use
    // instead of repeating the same countdown.
    const sameReset =
      s.resets_at != null &&
      d.weekly?.resets_at != null &&
      Math.abs(Date.parse(s.resets_at) - Date.parse(d.weekly.resets_at)) < 120_000;
    const sub = sameReset
      ? s.allowance_pct != null ? `max ${s.allowance_pct}% of weekly` : "resets with weekly"
      : undefined;
    const tip = modelTip(escapeHtml(s.name), s.allowance_pct, s.used_pct_of_weekly ?? null);
    html += row(`Weekly · ${escapeHtml(s.name)}`, s, { sub, tip });
  }

  html += renderFree(d);
  // The tip covers the whole section; its buttons keep their own tooltips.
  html += renderExtraUsage(d.extra_usage).replace(
    'class="spending-section',
    `data-tip="${escapeHtml(spendingTip(d.extra_usage))}" class="spending-section`,
  );
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
  wireUsageSettings(container);
  monoNumbers(container);
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
      monoNumbers(el);
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
