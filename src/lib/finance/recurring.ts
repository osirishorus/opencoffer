/**
 * Recurring-charge analysis.
 *
 * Pure functions over a merchant's charge history — no DB access — so the
 * Recurring page, the chat tool, and the price-increase alert all agree on
 * what "monthly", "next charge", and "price went up" mean.
 */

export type Cadence = "weekly" | "biweekly" | "monthly" | "quarterly" | "annual" | "irregular";

export type Charge = { date: Date; amount: number };

export type RecurringAnalysis = {
  cadence: Cadence;
  /** Median days between consecutive charges; null with fewer than 2 charges. */
  intervalDays: number | null;
  /** Median charge amount (absolute). */
  typicalAmount: number;
  /** Most recent charge amount (absolute). */
  lastAmount: number;
  /** typicalAmount normalised to a per-month cost using the detected cadence. */
  monthlyEquivalent: number;
  lastDate: Date;
  /** lastDate + cadence period; null when the cadence is irregular. */
  nextExpected: Date | null;
  /** False once a charge is overdue by more than half a period (likely cancelled). */
  active: boolean;
  /** Relative change of the last charge vs the median of prior charges, when ≥ 5% and ≥ $1. */
  priceChange: { from: number; to: number; pct: number } | null;
};

const DAY = 86_400_000;

const CADENCES: Array<{ cadence: Exclude<Cadence, "irregular">; days: number; tolerance: number }> = [
  { cadence: "weekly", days: 7, tolerance: 2 },
  { cadence: "biweekly", days: 14, tolerance: 3 },
  { cadence: "monthly", days: 30.44, tolerance: 6 },
  { cadence: "quarterly", days: 91.3, tolerance: 15 },
  { cadence: "annual", days: 365.25, tolerance: 30 },
];

const MONTHS_PER_PERIOD: Record<Exclude<Cadence, "irregular">, number> = {
  weekly: 12 / 52,
  biweekly: 12 / 26,
  monthly: 1,
  quarterly: 3,
  annual: 12,
};

export function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function classifyCadence(intervalDays: number | null): Cadence {
  if (intervalDays == null) return "irregular";
  for (const c of CADENCES) {
    if (Math.abs(intervalDays - c.days) <= c.tolerance) return c.cadence;
  }
  return "irregular";
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

export function analyzeRecurring(charges: Charge[], now = new Date()): RecurringAnalysis | null {
  if (charges.length === 0) return null;
  const sorted = [...charges].sort((a, b) => a.date.getTime() - b.date.getTime());
  const amounts = sorted.map((c) => Math.abs(c.amount));

  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const gap = (sorted[i].date.getTime() - sorted[i - 1].date.getTime()) / DAY;
    // Same-day duplicates (split charges, refunds re-billed) aren't a cadence signal.
    if (gap >= 1) gaps.push(gap);
  }
  const intervalDays = gaps.length ? round2(median(gaps)) : null;
  const cadence = classifyCadence(intervalDays);

  const typicalAmount = round2(median(amounts));
  const last = sorted[sorted.length - 1];
  const lastAmount = round2(Math.abs(last.amount));

  let monthlyEquivalent: number;
  let nextExpected: Date | null = null;
  let active: boolean;
  if (cadence === "irregular") {
    // Fall back to spreading total spend over the observed span.
    const spanMonths = Math.max(
      1,
      (last.date.getTime() - sorted[0].date.getTime()) / (30.44 * DAY),
    );
    monthlyEquivalent = round2(amounts.reduce((s, a) => s + a, 0) / spanMonths);
    active = now.getTime() - last.date.getTime() <= 45 * DAY;
  } else {
    const period = CADENCES.find((c) => c.cadence === cadence)!.days;
    monthlyEquivalent = round2(typicalAmount / MONTHS_PER_PERIOD[cadence]);
    nextExpected = new Date(last.date.getTime() + Math.round(period) * DAY);
    active = now.getTime() - nextExpected.getTime() <= (period / 2) * DAY;
  }

  let priceChange: RecurringAnalysis["priceChange"] = null;
  if (amounts.length >= 3) {
    const prior = round2(median(amounts.slice(0, -1)));
    const delta = lastAmount - prior;
    if (prior > 0 && Math.abs(delta) >= 1 && Math.abs(delta) / prior >= 0.05) {
      priceChange = { from: prior, to: lastAmount, pct: round2((delta / prior) * 100) };
    }
  }

  return {
    cadence,
    intervalDays,
    typicalAmount,
    lastAmount,
    monthlyEquivalent,
    lastDate: last.date,
    nextExpected,
    active,
    priceChange,
  };
}
