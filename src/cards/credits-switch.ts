// Usage credits switch: credits stay off by default, so past a plan limit
// Claude simply waits for the reset. When a run is worth pushing through, turn
// them on with a fixed allowance: the account's monthly spend limit set to
// "spent so far this month + allowance". Anthropic's servers stop the spend
// there, on every surface (claude.ai, the apps, Claude Duet, Claude Code).
//
// Pure: takes the normalized extra_usage block and the allowance, returns what
// the row shows. The dashboard only reads the account; the switch itself is
// flipped by the user on claude.ai's usage settings, which the button opens.

export interface CreditsInput {
  is_enabled: boolean;
  monthly_limit: number | null;
  used: number | null;
  spend_limit_reached: boolean;
}

export type CreditsTone = "off" | "on" | "spent" | "loose" | "none";

export interface CreditsAction {
  /** Button text. */
  label: string;
  /** Monthly limit to set in Adjust limit, when it can be worked out. */
  target: number | null;
}

export interface CreditsView {
  tone: CreditsTone;
  /** Short state, e.g. "Off" or "On · $1.50 left". */
  label: string;
  /** One line under it. */
  detail: string;
  action: CreditsAction | null;
}

export const DEFAULT_ALLOWANCE_USD = 2;
/** Less than half a cent left counts as nothing left. */
const SLACK = 0.005;

const money = (n: number) => `$${n.toFixed(2)}`;
const cents = (n: number) => Math.round(n * 100) / 100;

export function creditsView(eu: CreditsInput | null | undefined, allowance: number): CreditsView | null {
  if (!eu) return null;
  const a = money(allowance);
  const target = eu.used != null ? cents(eu.used + allowance) : null;

  if (!eu.is_enabled) {
    return {
      tone: "off",
      label: "Off",
      detail:
        target != null
          ? "Past a limit, Claude waits for the reset"
          : `Past a limit, Claude waits. To turn on, set the limit to this month's spend + ${a}`,
      action: { label: `Turn on for ${a}`, target },
    };
  }
  if (eu.monthly_limit == null) {
    return {
      tone: "none",
      label: "On · no limit",
      detail: "Anything past a plan limit spends credits. Set a limit or turn them off",
      action: { label: `Limit to ${a}`, target },
    };
  }
  const left = eu.monthly_limit - (eu.used ?? 0);
  if (eu.spend_limit_reached || left < SLACK) {
    return {
      tone: "spent",
      label: "Allowance used",
      detail: "Credits stopped at the limit. Turn them off, or allow another round",
      action: { label: `Allow ${a} more`, target },
    };
  }
  if (left > allowance + SLACK) {
    return {
      tone: "loose",
      label: `On · ${money(cents(left))} open`,
      detail: `More than ${a} could be spent. Turn credits off, or lower the limit`,
      action: { label: `Limit to ${a}`, target },
    };
  }
  return {
    tone: "on",
    label: `On · ${money(cents(left))} left`,
    detail: "Stops by itself when this runs out",
    action: null,
  };
}
