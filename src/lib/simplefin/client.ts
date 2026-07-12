/**
 * SimpleFIN client.
 *
 * The protocol (https://www.simplefin.org/protocol.html) is brutally simple:
 *
 *   1. User goes to a SimpleFIN Bridge (e.g. https://bridge.simplefin.org/),
 *      links their banks, and gets a **setup token** — a base64-encoded URL.
 *   2. We base64-decode it to get a one-time *claim URL* and POST to it.
 *      The response body is the **access URL**, which embeds basic-auth creds
 *      and points at the bridge: e.g.
 *        https://USER:PASS@beta-bridge.simplefin.org/simplefin
 *   3. To fetch data: `GET <access-url>/accounts?start-date=…&end-date=…&pending=1`.
 *      One endpoint returns *all* linked institutions, accounts, balances, and
 *      transactions in a single JSON payload.
 *
 * We store only the access URL (encrypted). Setup tokens are single-use and
 * never persisted.
 */

export type SFTransaction = {
  id: string;
  posted: number; // unix seconds; 0 when the transaction is still pending
  /** Unix seconds the transaction occurred — often the only usable date on pending rows. */
  transacted_at?: number;
  amount: string; // signed; negative = outflow, positive = inflow
  description: string;
  payee?: string;
  memo?: string;
  pending?: boolean;
  category?: string;
};

export type SFHolding = {
  id: string;
  created?: number;
  currency?: string;
  cost_basis?: string;
  description?: string;
  market_value?: string;
  purchase_price?: string;
  shares?: string;
  symbol?: string;
};

export type SFAccount = {
  org: { domain?: string; name?: string; "sfin-url"?: string; url?: string };
  id: string;
  name: string;
  currency: string;
  balance: string;
  "available-balance"?: string;
  "balance-date": number;
  transactions?: SFTransaction[];
  holdings?: SFHolding[];
  extra?: Record<string, unknown>;
};

export type SFResponse = {
  errors: string[];
  accounts: SFAccount[];
};

/**
 * Decode a SimpleFIN setup token and POST to the claim URL to receive the
 * permanent access URL. Setup tokens are single-use — call this exactly once
 * per user-supplied token.
 */
export async function claimSetupToken(setupToken: string): Promise<string> {
  const trimmed = setupToken.trim();
  let claimUrl: string;
  try {
    claimUrl = Buffer.from(trimmed, "base64").toString("utf8").trim();
  } catch {
    throw new Error("Setup token is not valid base64.");
  }
  if (!/^https?:\/\//i.test(claimUrl)) {
    throw new Error("Setup token did not decode to a URL. Make sure you copied the whole token.");
  }
  const res = await fetch(claimUrl, { method: "POST", headers: { "content-length": "0" } });
  const accessUrl = (await res.text()).trim();
  if (!res.ok || !/^https?:\/\//i.test(accessUrl)) {
    throw new Error(
      `Claim failed (${res.status}): ${accessUrl.slice(0, 200)}. Tokens are one-time — get a fresh one from your bridge.`,
    );
  }
  return accessUrl;
}

/**
 * Pull accounts + transactions from SimpleFIN.
 *
 * @param accessUrl  the URL stored at connect time (contains basic-auth)
 * @param startDate  optional Date — only return transactions on/after this
 * @param endDate    optional Date — only return transactions on/before this
 */
export async function fetchAccounts(
  accessUrl: string,
  opts: { startDate?: Date; endDate?: Date } = {},
): Promise<SFResponse> {
  // Node's undici-based fetch rejects URLs with embedded userinfo. Extract the
  // basic-auth credentials and send them as a header instead.
  const u = new URL(`${accessUrl.replace(/\/$/, "")}/accounts`);
  const user = decodeURIComponent(u.username);
  const pass = decodeURIComponent(u.password);
  u.username = "";
  u.password = "";
  if (opts.startDate) u.searchParams.set("start-date", String(Math.floor(opts.startDate.getTime() / 1000)));
  if (opts.endDate) u.searchParams.set("end-date", String(Math.floor(opts.endDate.getTime() / 1000)));
  u.searchParams.set("pending", "1");
  const headers: Record<string, string> = { accept: "application/json" };
  if (user || pass) {
    headers.authorization = "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
  }
  const res = await fetch(u.toString(), { headers });
  const body = await res.text();
  if (!res.ok) {
    throw new Error(`SimpleFIN /accounts returned ${res.status}: ${body.slice(0, 300)}`);
  }
  try {
    return JSON.parse(body) as SFResponse;
  } catch {
    throw new Error(`SimpleFIN returned non-JSON: ${body.slice(0, 300)}`);
  }
}

/**
 * SimpleFIN doesn't expose account type/subtype directly. Classify based on
 * the org name + account name + presence of holdings. Conservative — falls
 * back to "depository" for anything bank-shaped.
 */
/**
 * Finer-grained "what kind of account is this" bucket used by the AI for analysis.
 * Distinct from `type` because two investment accounts (a 401k and a taxable brokerage)
 * should be analyzed very differently even though they're both `type: investment`.
 */
export function classifyAccountGroup(a: SFAccount, type: string): string {
  const name = a.name.toLowerCase();
  if (type === "depository") {
    return /\bsavings\b/.test(name) ? "cash" : "cash"; // savings + checking both → spendable cash
  }
  if (type === "credit") return "credit";
  if (type === "loan") return "loan";
  if (type === "investment") {
    if (/\bhsa|health savings\b/.test(name)) return "hsa";
    if (/\b(401k|403b|ira|roth|rsp|savings incentive plan|tsp|sep|pension)\b/.test(name)) return "retirement";
    return "brokerage";
  }
  return "other";
}

/**
 * Heuristic: is this transaction an internal money movement (transfer between
 * the user's own accounts, or a credit-card payment) rather than real spending
 * or real income? We exclude these from spending/income aggregations.
 */
export function isTransferTransaction(
  t: SFTransaction,
  accountType: string,
): boolean {
  // Any inflow to a credit-card account is virtually always a payment to the
  // card (or a refund — which nets out anyway). Never real income.
  if (accountType === "credit" && Number(t.amount) > 0) return true;

  const blob = `${t.description ?? ""} ${t.payee ?? ""} ${t.memo ?? ""}`.toLowerCase();

  // Patterns that always signal internal money movement (between user's own
  // accounts) or credit-card payments. Tightly scoped to avoid catching real
  // spending — e.g. "Zelle payment to Jing Le for rent" is NOT one of these.
  const TRANSFER_PATTERNS = [
    /\bcredit\s?card\s?(payment|pmt)\b/,
    /\bcc\s?(payment|pmt)\b/,
    /\bcard\s?(payment|pmt)\b/,
    /\bautopay\b/,
    /\bbankamericard\b/,
    /\bamex\s?epayment\b/,
    /\bamerican\s?express.*ach\s?pmt\b/,
    /\bchase\s?epay\b/,
    /\bcapital\s?one\s?mobile\b/,
    /\bciti\s?autopay\b/,
    /\bcardmember\s?serweb\b/,
    /\bpayment\s?thank\s?you\b/,
    /\bonline\s?payment\s?to\b/,
    /\btransferred\s?(from|to)\s?overdraft\b/,
    /\boverdraft\s?transfer\b/,
    /\belectronic\s?funds\s?transfer\s?(paid|received)\b/,
    /\bdes:moneyline\b/,
    /\bfid\s?bkg\s?svc\b/,
    // Fidelity "core position" cash account artifacts: positive entries labelled
    // as "DIRECT DEBIT <merchant> PAYMENT (Cash)" are the credit half of an
    // overdraft pass-through funding a bill payment, not real income.
    /\bdirect\s?debit\b.*\bpayment\b/,
  ];
  if (TRANSFER_PATTERNS.some((re) => re.test(blob))) return true;

  return false;
}

export function classifyAccount(a: SFAccount): { type: string; subtype: string | null } {
  const name = a.name.toLowerCase();
  const blob = `${a.org?.name ?? ""} ${name}`.toLowerCase();
  // Card-like names beat brokerage-name matches: Fidelity Rewards Visa is a
  // credit card, not an investment account.
  if (/\b(visa|mastercard|amex|american express|credit card|rewards card)\b/.test(name)) {
    return { type: "credit", subtype: "credit card" };
  }
  if (a.holdings && a.holdings.length > 0) return { type: "investment", subtype: null };
  if (/\b(401k|403b|ira|roth|brokerage|investment|hsa|rsp|savings incentive plan)\b/.test(name)) {
    return { type: "investment", subtype: null };
  }
  if (/\b(fidelity|vanguard|schwab|merrill|etrade)\b/.test(blob) && !/\b(checking|savings)\b/.test(name)) {
    return { type: "investment", subtype: null };
  }
  if (/\b(credit|card)\b/.test(blob)) {
    return { type: "credit", subtype: "credit card" };
  }
  if (/\b(loan|mortgage|auto loan|student)\b/.test(blob)) {
    return { type: "loan", subtype: null };
  }
  if (/\b(savings)\b/.test(blob)) return { type: "depository", subtype: "savings" };
  return { type: "depository", subtype: "checking" };
}
