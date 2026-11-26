// Demo mode (`npm run demo`): stands in for the Rust side so the widget renders
// in a plain browser. Every number here is invented: the usage, quota,
// spending and credits belong to no account, and the Agile prices are a
// made-up winter day, not published tariff data. Times are relative to the
// page's clock, so the widget looks live whenever it is opened.
//
// URL flags: `?theme=dark` or `?theme=light` fixes the theme. Inside an iframe
// (docs/preview/preview.html), the widget's height is posted to the parent,
// which stands in for the Tauri window.

import type { InvokeArgs } from "@tauri-apps/api/core";
import type { ClaudeUsageData, StatsPayload } from "./cards/claude-usage";
import type { AgileData, AgileSlot } from "./cards/octopus-agile";

const MIN = 60_000;
const HOUR = 60 * MIN;
const iso = (ms: number) => new Date(ms).toISOString();

function claudeUsage(now: number): ClaudeUsageData {
  const nextMonth = new Date(now);
  nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1, 1);
  nextMonth.setUTCHours(0, 0, 0, 0);
  return {
    plan: "max 5x",
    session: { utilization: 38, resets_at: iso(now + 2 * HOUR + 14 * MIN) },
    weekly: { utilization: 61, resets_at: iso(now + 3 * 24 * HOUR + 5 * HOUR) },
    weekly_sonnet: { utilization: 44, resets_at: iso(now + 3 * 24 * HOUR + 5 * HOUR) },
    weekly_opus: null,
    scoped: [
      { name: "Fable", utilization: 12, resets_at: iso(now + 3 * 24 * HOUR + 5 * HOUR), allowance_pct: 50 },
    ],
    free_resets: [
      { label: "Free limit reset", kind: "full", left: 1, usable_now: true, ends_at: iso(now + 20 * 24 * HOUR) },
      { label: "New model launch: one Fable reset", kind: "Fable", left: 2, usable_now: true, ends_at: iso(now + 90 * 24 * HOUR) },
    ],
    free_credits: [
      {
        label: "Claude Duet credit",
        left: 212.4,
        total: 300,
        utilization: 29,
        resets_at: iso(now + 4 * 24 * HOUR),
        ends_at: iso(now + 35 * 24 * HOUR),
      },
    ],
    breakdown: [
      { name: "Claude Code", percent: 74 },
      { name: "Chats", percent: 26 },
    ],
    extra_usage: {
      is_enabled: false,
      monthly_limit: null,
      used: 12.4,
      balance: null,
      utilization: null,
      spend_limit_reached: false,
      resets_at: iso(nextMonth.getTime()),
    },
    prepaid: {
      balance: 31.6,
      active_credit: 50,
      credit_seen: 50,
      credit_added: 0,
      tracking_since_ms: now - 40 * 24 * HOUR,
      paid_this_month: 45,
      paid_tracked: 0,
      auto_reload: false,
      reload_threshold: null,
      reload_to: null,
    },
  };
}

// p/kWh for each half hour from 00:00, London time: a windy night that dips
// below zero, a morning rise, a midday trough and the 16:00–19:00 peak.
const PRICES = [
  13.1, 11.8, 9.6, 7.2, 4.1, -0.8, -1.6, 1.9, 5.4, 8.8, 11.2, 13.9,
  17.4, 20.1, 23.6, 25.2, 24.8, 22.3, 20.7, 19.4, 18.1, 17.6, 16.2, 15.3,
  14.1, 13.4, 12.8, 12.2, 12.9, 13.7, 16.4, 19.8, 31.2, 34.6, 36.9, 35.1,
  32.4, 27.9, 22.6, 21.3, 20.4, 19.1, 18.2, 17.0, 16.3, 15.1, 14.4, 13.2,
];

/** Midnight in London for the day that contains `now`. */
function londonMidnight(now: number): number {
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(now);
  const utcMidnight = Date.parse(`${day}T00:00:00Z`);
  const hour = Number(
    new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", hourCycle: "h23" }).format(utcMidnight),
  );
  return utcMidnight - hour * HOUR; // British Summer Time puts midnight at 23:00 UTC
}

function octopusAgile(now: number): AgileData {
  const start = londonMidnight(now);
  const slots: AgileSlot[] = PRICES.map((p, i) => ({
    start: iso(start + i * 30 * MIN),
    end: iso(start + (i + 1) * 30 * MIN),
    p,
  }));
  return { region: "C", product: "AGILE-DEMO", slots };
}

function payload<T>(data: T): StatsPayload<T> {
  return { ok: true, data, fetched_at: Date.now() - MIN, next_poll_secs: 300 };
}

function postHeight(height: number): void {
  if (window.parent !== window) window.parent.postMessage({ demoHeight: height, theme: themeFlag }, "*");
}

const themeFlag = new URLSearchParams(location.search).get("theme");

/** Applies the URL flags. Called once, only in demo mode. */
export function setup(): void {
  if (themeFlag === "dark" || themeFlag === "light") document.documentElement.dataset.theme = themeFlag;
  if (window.parent === window) {
    // Opened on its own: give the page the stone ground a desktop would provide.
    document.documentElement.style.background = "var(--ground)";
    document.body.style.cssText = "width:340px;margin:48px auto;overflow:visible";
  }
}

export async function invoke<T>(cmd: string, args?: InvokeArgs): Promise<T> {
  const now = Date.now();
  const a = (args ?? {}) as Record<string, unknown>;
  const answers: Record<string, () => unknown> = {
    get_layout: () => ({ order: [], collapsed: [] }),
    get_budget: () => null,
    claude_activity: () => now - 40_000,
    get_stats: () =>
      a.providerId === "claude-usage"
        ? payload(claudeUsage(now))
        : a.providerId === "octopus-agile"
          ? payload(octopusAgile(now))
          : null,
    resize_window: () => postHeight(Number(a.height)),
  };
  return (answers[cmd]?.() ?? null) as T;
}

// No events in demo mode: every card is drawn once from get_stats.
export async function listen(): Promise<() => void> {
  return () => {};
}

export async function emit(): Promise<void> {}
