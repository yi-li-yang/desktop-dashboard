import type { StatsPayload } from "./claude-usage";

export interface AgileSlot {
  start: string;
  end: string;
  p: number; // p/kWh inc VAT
}

export interface AgileData {
  region: string;
  product: string;
  slots: AgileSlot[];
}

export interface AgileWindow {
  start: number;
  end: number;
  avg: number;
  day: "today" | "tomorrow";
  cheapest: boolean;
}

interface DayView {
  slots: AgileSlot[];
  avg: number;
}

export interface AgileAnalysis {
  current: AgileSlot | null;
  today: DayView | null;
  tomorrow: DayView | null;
  windows: AgileWindow[];
}

const TZ = "Europe/London";
const MAX_WINDOWS = 3;

const dayFmt = new Intl.DateTimeFormat("en-CA", { timeZone: TZ });
const timeFmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: TZ,
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

const dayKey = (ms: number) => dayFmt.format(ms);
const clock = (ms: number) => timeFmt.format(ms);
const mean = (xs: AgileSlot[]) => xs.reduce((s, x) => s + x.p, 0) / xs.length;

function dayView(slots: AgileSlot[]): DayView | null {
  return slots.length ? { slots, avg: mean(slots) } : null;
}

/** Merges consecutive below-average slots of one day into windows. */
function belowAverageRuns(day: DayView, which: AgileWindow["day"], now: number): AgileWindow[] {
  const runs: AgileSlot[][] = [];
  let run: AgileSlot[] = [];
  for (const s of day.slots) {
    const contiguous = run.length && run[run.length - 1].end === s.start;
    if (s.p < day.avg) {
      if (run.length && !contiguous) {
        runs.push(run);
        run = [];
      }
      run.push(s);
    } else if (run.length) {
      runs.push(run);
      run = [];
    }
  }
  if (run.length) runs.push(run);

  return runs
    .map((r) => ({
      start: Date.parse(r[0].start),
      end: Date.parse(r[r.length - 1].end),
      avg: mean(r),
      day: which,
      cheapest: false,
    }))
    .filter((w) => w.end > now);
}

/** Pure: derives everything the card shows from the raw slots and a clock. */
export function analyze(slots: AgileSlot[], now: number): AgileAnalysis {
  const todayKey = dayKey(now);
  const todaySlots: AgileSlot[] = [];
  const laterSlots: AgileSlot[] = [];
  for (const s of slots) {
    const k = dayKey(Date.parse(s.start));
    if (k === todayKey) todaySlots.push(s);
    else if (k > todayKey) laterSlots.push(s);
  }
  // Only the first later day (tomorrow) is ever published.
  const tomorrowKey = laterSlots.length ? dayKey(Date.parse(laterSlots[0].start)) : null;
  const tomorrowSlots = laterSlots.filter((s) => dayKey(Date.parse(s.start)) === tomorrowKey);

  const today = dayView(todaySlots);
  const tomorrow = dayView(tomorrowSlots);
  const current =
    slots.find((s) => Date.parse(s.start) <= now && now < Date.parse(s.end)) ?? null;

  const all = [
    ...(today ? belowAverageRuns(today, "today", now) : []),
    ...(tomorrow ? belowAverageRuns(tomorrow, "tomorrow", now) : []),
  ];
  // Keep the cheapest few, shown in time order; flag the single cheapest.
  const picked = [...all].sort((a, b) => a.avg - b.avg).slice(0, MAX_WINDOWS);
  if (picked.length) picked[0].cheapest = true;
  const windows = picked.sort((a, b) => a.start - b.start);

  return { current, today, tomorrow, windows };
}

const fmtP = (p: number) => `${p.toFixed(2)}p`;

function chart(day: DayView, scale: { min: number; max: number }, now: number, label: string): string {
  const { min, max } = scale;
  const H = 100;
  const span = max - min || 1;
  const y0 = (max / span) * H; // zero line
  const n = day.slots.length;

  const bars = day.slots
    .map((s, i) => {
      const t0 = Date.parse(s.start);
      const t1 = Date.parse(s.end);
      const h = (Math.abs(s.p) / span) * H;
      const y = s.p >= 0 ? y0 - h : y0;
      const cls = [
        "agile-bar",
        s.p < 0 ? "bar-neg" : s.p < day.avg ? "bar-low" : "bar-high",
        t1 <= now ? "bar-past" : "",
      ].join(" ");
      const now_ = t0 <= now && now < t1;
      const hl = now_ ? `<rect class="agile-now-col" x="${i}" y="0" width="1" height="${H}"/>` : "";
      return `${hl}<rect class="${cls}" x="${i + 0.1}" y="${y.toFixed(2)}" width="0.8" height="${Math.max(h, 0.8).toFixed(2)}"><title>${clock(t0)} · ${fmtP(s.p)}</title></rect>`;
    })
    .join("");

  const zero = min < 0 ? `<line class="agile-zero" x1="0" x2="${n}" y1="${y0}" y2="${y0}"/>` : "";
  return `
    <div class="agile-chart-label">${label}<span>avg ${fmtP(day.avg)}</span></div>
    <svg class="agile-chart" viewBox="0 0 ${n} ${H}" preserveAspectRatio="none">${zero}${bars}</svg>`;
}

function windowsList(windows: AgileWindow[], now: number): string {
  if (!windows.length) return "";
  const rows = windows
    .map((w) => {
      const live = w.start <= now && now < w.end;
      const when = `${w.day === "tomorrow" ? "Tomorrow " : ""}${clock(w.start)}–${clock(w.end)}`;
      return `<div class="agile-window${w.cheapest ? " cheapest" : ""}${live ? " live" : ""}">
        <span class="agile-window-time">${when}${live ? " <em>now</em>" : ""}</span>
        <span class="agile-window-price">${w.cheapest ? "cheapest · " : ""}avg ${fmtP(w.avg)}</span>
      </div>`;
    })
    .join("");
  return `<div class="agile-windows"><div class="agile-sub">Below-average windows</div>${rows}</div>`;
}

function build(data: AgileData, now: number): { html: string; negative: boolean } {
  const a = analyze(data.slots, now);
  const cur = a.current;
  const negative = !!cur && cur.p < 0;

  if (!a.today && !a.tomorrow) {
    return { html: `<div class="card-error">No Agile prices available</div>`, negative: false };
  }

  const ref = a.today?.avg ?? a.tomorrow!.avg;
  let nowHtml: string;
  if (cur) {
    const below = cur.p < ref;
    const cue = negative
      ? `<span class="agile-badge badge-paid">Paid to use</span>`
      : `<span class="agile-cue ${below ? "cue-low" : "cue-high"}">${below ? "▼ below average" : "▲ above average"}</span>`;
    nowHtml = `
      <div class="agile-now">
        <span class="agile-price${negative ? " neg" : below ? " low" : ""}">${fmtP(cur.p)}<small>/kWh</small></span>
        ${cue}
      </div>
      <div class="agile-until">until ${clock(Date.parse(cur.end))}</div>`;
  } else {
    nowHtml = `<div class="agile-now"><span class="agile-price">—</span></div>`;
  }

  const days = [a.today, a.tomorrow].filter((d): d is DayView => d !== null);
  const all = days.flatMap((d) => d.slots.map((s) => s.p));
  const scale = { min: Math.min(0, ...all), max: Math.max(0, ...all) };

  const charts =
    (a.today ? chart(a.today, scale, now, "Today") : "") +
    (a.tomorrow ? chart(a.tomorrow, scale, now, "Tomorrow") : "");

  const html = `
    ${nowHtml}
    ${charts}
    ${windowsList(a.windows, now)}`;
  return { html, negative };
}

const cache = new WeakMap<HTMLElement, AgileData>();
const shown = new WeakMap<HTMLElement, string>();

function paint(container: HTMLElement, data: AgileData): void {
  const { html, negative } = build(data, Date.now());
  // The glow belongs on the whole box, not just the body.
  container.closest(".card")?.classList.toggle("negative-price", negative);
  // Skip identical markup so the 30s tick doesn't restart CSS animations.
  if (shown.get(container) === html) return;
  shown.set(container, html);
  container.innerHTML = html;
}

export function renderOctopusAgile(container: HTMLElement, payload: StatsPayload<AgileData>): void {
  if (!payload.ok) {
    if (!cache.has(container)) {
      container.innerHTML = `<div class="card-error">${payload.error?.message ?? "Unknown error"}</div>`;
    }
    return;
  }
  cache.set(container, payload.data!);
  paint(container, payload.data!);
}

/** Re-evaluates the current slot from cached prices without a new fetch. */
export function tickAgile(container: HTMLElement): void {
  const data = cache.get(container);
  if (data) paint(container, data);
}
