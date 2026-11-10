// Spend fuse: uses the account's monthly spend limit as a per-run cap.
//
// The monthly limit is the only control that stops usage credits everywhere
// (claude.ai, the Claude apps, Claude Code, cloud sessions), enforced by
// Anthropic's servers. Kept at "spent so far this month + fuse", it means any
// one run past the plan's limits can spend at most the fuse before it stops.
// When it trips, raising it by another fuse is a deliberate, one-step choice.
//
// Pure: takes the normalized extra_usage block and the fuse size, returns what
// to show. The account limit is read only; nothing here changes it.

export interface FuseInput {
  is_enabled: boolean;
  monthly_limit: number | null;
  used: number | null;
  spend_limit_reached: boolean;
}

export type FuseTone = "off" | "none" | "blown" | "loose" | "armed";

export interface FuseView {
  tone: FuseTone;
  /** Short state, e.g. "Armed". */
  label: string;
  /** One line under it. */
  detail: string;
  /** Limit to set in Settings > Usage, when a change is suggested. */
  target: number | null;
}

export const DEFAULT_FUSE_USD = 2;
/** Less than half a cent left counts as nothing left. */
const SLACK = 0.005;

const money = (n: number) => `$${n.toFixed(2)}`;
const cents = (n: number) => Math.round(n * 100) / 100;

export function fuseView(eu: FuseInput | null | undefined, fuseUsd: number): FuseView | null {
  if (!eu) return null;
  if (!eu.is_enabled) {
    return {
      tone: "off",
      label: "Credits off",
      detail: "Nothing spends credits: past a limit, Claude waits for the reset",
      target: null,
    };
  }
  const used = eu.used ?? 0;
  const target = cents(used + fuseUsd);

  if (eu.monthly_limit == null) {
    return {
      tone: "none",
      label: "No fuse",
      detail: `No monthly limit, so one run can spend without end. Set it to ${money(target)}`,
      target,
    };
  }
  const headroom = eu.monthly_limit - used;
  if (eu.spend_limit_reached || headroom < SLACK) {
    return {
      tone: "blown",
      label: "Fuse blown",
      detail: `Credits stopped at ${money(eu.monthly_limit)}. To keep going, raise the limit to ${money(target)}`,
      target,
    };
  }
  if (headroom > fuseUsd + SLACK) {
    return {
      tone: "loose",
      label: "Fuse loose",
      detail: `One run could spend ${money(cents(headroom))}. Lower the limit to ${money(target)}`,
      target,
    };
  }
  return {
    tone: "armed",
    label: "Armed",
    detail: `A run past the limits stops after ${money(cents(headroom))} more`,
    target: null,
  };
}
