import { cn } from "@/lib/utils";

/**
 * Currency set the way a ledger sets it: significant digits at full weight,
 * cents demoted to a smaller, dimmer size, decimal points aligned down the
 * column.
 *
 * Why bother — in a column of tabular figures the cents are visual noise. They
 * carry a hundredth of the information of the leading digits but take up the
 * same space and contrast, so scanning "which of these is the big one" is
 * slower than it should be. Demoting them lets the eye land on magnitude first.
 * Because the cents keep their exact advance width, the decimal points still
 * line up, so nothing is traded away for the gain.
 *
 * Built on Intl.formatToParts rather than string splitting so it stays correct
 * for currencies that put the symbol on the right (12,50 €), use a comma as the
 * decimal separator, or have no minor unit at all (¥1000).
 */

type AmountProps = {
  value: number;
  currency?: string | null;
  /** Prefix an explicit + on positive values. Off by default. */
  signed?: boolean;
  /** Colour by direction: green for inflow, red for outflow. */
  tone?: "none" | "flow" | "negative-only";
  className?: string;
};

function partsFor(value: number, currency: string) {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
    }).formatToParts(value);
  } catch {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
    }).formatToParts(value);
  }
}

export function Amount({
  value,
  currency,
  signed = false,
  tone = "none",
  className,
}: AmountProps) {
  const code = currency && currency.trim() ? currency.trim().toUpperCase() : "USD";
  // Format the magnitude; the sign is rendered separately so we can use a real
  // minus sign (U+2212), which shares its width with the digits in a tabular
  // face. A hyphen does not, and it breaks column alignment.
  const parts = partsFor(Math.abs(value), code);

  // Three buckets, in render order: everything up to the decimal, the decimal
  // separator plus cents, then whatever trails (a space and the symbol, for
  // locales like de-DE that render "1.234,56 €"). The trailing symbol must stay
  // at full size AND keep its position — folding it into the head would print
  // "1.234€,56".
  const head: string[] = [];
  const cents: string[] = [];
  const suffix: string[] = [];
  let phase: "head" | "cents" | "suffix" = "head";
  for (const part of parts) {
    if (part.type === "decimal") {
      phase = "cents";
      cents.push(part.value);
      continue;
    }
    if (phase === "cents" && part.type !== "fraction") phase = "suffix";
    (phase === "head" ? head : phase === "cents" ? cents : suffix).push(part.value);
  }

  const negative = value < 0;
  const sign = negative ? "−" : signed ? "+" : "";
  const toneClass =
    tone === "flow"
      ? negative
        ? "text-on-surface"
        : "text-success"
      : tone === "negative-only" && negative
        ? "text-error"
        : "";

  return (
    <span className={cn("num whitespace-nowrap", toneClass, className)}>
      {sign && <span className="amt-sign">{sign}</span>}
      {head.join("")}
      {cents.length > 0 && (
        <span className="text-[0.78em] opacity-60">{cents.join("")}</span>
      )}
      {suffix.join("")}
    </span>
  );
}
