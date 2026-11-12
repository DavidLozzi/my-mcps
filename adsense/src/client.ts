import { getAccessToken, NotAuthenticatedError, PACKAGE_ROOT } from "./auth.js";
import { normalizeAccountId } from "./lib/account.js";
import type { DateRange } from "./lib/dates.js";

// Overridable so the analysis logic can be exercised against a stub API.
const API_BASE = process.env.ADSENSE_API_BASE ?? "https://adsense.googleapis.com";

/** An API failure already phrased as something Claude can act on. */
export class AdSenseApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "AdSenseApiError";
  }
}

interface GoogleErrorBody {
  error?: { message?: string; status?: string };
}

async function get<T>(path: string, query?: URLSearchParams): Promise<T> {
  const token = await getAccessToken();
  const qs = query && [...query.keys()].length > 0 ? `?${query}` : "";

  const res = await fetch(`${API_BASE}/v2/${path}${qs}`, {
    headers: { authorization: `Bearer ${token}` },
  });

  if (res.ok) {
    const text = await res.text();
    return (text ? JSON.parse(text) : {}) as T;
  }

  const raw = await res.text();
  let googleMessage = raw.slice(0, 600);
  try {
    const parsed = JSON.parse(raw) as GoogleErrorBody;
    googleMessage = parsed.error?.message ?? googleMessage;
  } catch {
    /* Non-JSON error body; use the raw text. */
  }

  throw new AdSenseApiError(explain(res.status, googleMessage), res.status);
}

/**
 * Turn an HTTP status into a next step. The common 400 is a dimension and
 * metric that AdSense will not report together (PAGE_URL in particular only
 * supports a subset of metrics), so that case points at the field reference.
 */
function explain(status: number, googleMessage: string): string {
  switch (status) {
    case 400:
      return (
        `Bad request (400): ${googleMessage}\n\n` +
        `Usually a dimension or metric name that does not exist, or a combination AdSense refuses ` +
        `to report together (PAGE_URL, for one, supports only a subset of metrics). Names are ` +
        `UPPER_SNAKE_CASE API enums such as ESTIMATED_EARNINGS and PAGE_VIEWS_RPM — ` +
        `adsense_report_fields lists the common ones. Filters use AdSense syntax: ` +
        `DIMENSION==value, DIMENSION=@contains, != and !@ to negate.`
      );

    case 401:
      return (
        `Google rejected the credentials (401): ${googleMessage}\n\n` +
        `The token was revoked or expired. Re-authenticate:\n  cd ${PACKAGE_ROOT} && npm run auth`
      );

    case 403:
      return (
        `Access denied (403): ${googleMessage}\n\n` +
        `Either the AdSense Management API is not enabled in the Cloud project that owns the OAuth ` +
        `client, or this Google account has no access to that AdSense account. Call ` +
        `adsense_list_accounts to see the accounts this login can reach.`
      );

    case 404:
      return (
        `Not found (404): ${googleMessage}\n\n` +
        `Check the account (pub-…) and any ad client or ad unit id — adsense_list_accounts and ` +
        `adsense_ad_units return the exact ids.`
      );

    case 429:
      return (
        `Quota exhausted (429): ${googleMessage}\n\n` +
        `The AdSense Management API limits requests per project per minute and per day. Wait a ` +
        `minute and retry, or combine questions into fewer report calls.`
      );

    default:
      if (status >= 500) {
        return `Google returned ${status}: ${googleMessage}\n\nThis is a transient Google-side error; retrying usually works.`;
      }
      return `AdSense API error ${status}: ${googleMessage}`;
  }
}

export { NotAuthenticatedError };

/** Follow nextPageToken until the collection is exhausted. */
async function listAll<T>(path: string, key: string, extra?: Record<string, string>): Promise<T[]> {
  const items: T[] = [];
  let pageToken: string | undefined;
  do {
    const qs = new URLSearchParams({ pageSize: "500", ...extra });
    if (pageToken) qs.set("pageToken", pageToken);
    const res = await get<Record<string, unknown>>(path, qs);
    items.push(...((res[key] as T[] | undefined) ?? []));
    pageToken = res.nextPageToken as string | undefined;
  } while (pageToken);
  return items;
}

// ---------------------------------------------------------------------------
// Accounts and inventory
// ---------------------------------------------------------------------------

export interface GoogleDate {
  year?: number;
  month?: number;
  day?: number;
}

export function formatGoogleDate(d?: GoogleDate): string {
  if (!d?.year) return "";
  return `${d.year}-${String(d.month ?? 1).padStart(2, "0")}-${String(d.day ?? 1).padStart(2, "0")}`;
}

export interface Account {
  name?: string;
  displayName?: string;
  timeZone?: { id?: string };
  createTime?: string;
  pendingTasks?: string[];
  premium?: boolean;
  state?: string;
}

export function listAccounts(): Promise<Account[]> {
  return listAll<Account>("accounts", "accounts");
}

/**
 * Nearly every publisher has exactly one AdSense account, so `account` is
 * optional everywhere: when omitted, use the only one this login can reach.
 */
export async function resolveAccount(input?: string): Promise<string> {
  if (input) return normalizeAccountId(input);

  const accounts = (await listAccounts()).filter((a) => a.state !== "CLOSED");
  if (accounts.length === 1) return accounts[0]!.name!;
  if (accounts.length === 0) {
    throw new AdSenseApiError(
      "This Google account has no open AdSense account. Either a different Google account was used " +
        "during `npm run auth`, or AdSense was never set up for it.",
      404,
    );
  }
  throw new AdSenseApiError(
    `This login reaches ${accounts.length} AdSense accounts, so pass \`account\`:\n` +
      accounts.map((a) => `  ${(a.name ?? "").replace(/^accounts\//, "")}  ${a.displayName ?? ""}`).join("\n"),
    400,
  );
}

export interface AdClient {
  name?: string;
  reportingDimensionId?: string;
  productCode?: string;
  state?: string;
}

export function listAdClients(account: string): Promise<AdClient[]> {
  return listAll<AdClient>(`${account}/adclients`, "adClients");
}

export interface AdUnit {
  name?: string;
  reportingDimensionId?: string;
  displayName?: string;
  state?: string;
  contentAdsSettings?: { type?: string; size?: string };
}

export function listAdUnits(adClient: string): Promise<AdUnit[]> {
  return listAll<AdUnit>(`${adClient}/adunits`, "adUnits");
}

export interface Site {
  name?: string;
  reportingDimensionId?: string;
  domain?: string;
  state?: string;
  autoAdsEnabled?: boolean;
}

export function listSites(account: string): Promise<Site[]> {
  return listAll<Site>(`${account}/sites`, "sites");
}

export interface Alert {
  name?: string;
  message?: string;
  severity?: string;
  type?: string;
}

export async function listAlerts(account: string): Promise<Alert[]> {
  const res = await get<{ alerts?: Alert[] }>(
    `${account}/alerts`,
    new URLSearchParams({ languageCode: "en" }),
  );
  return res.alerts ?? [];
}

export interface PolicyIssue {
  name?: string;
  site?: string;
  siteSection?: string;
  uri?: string;
  entityType?: string;
  action?: string;
  adRequestCount?: string;
  firstDetectedDate?: GoogleDate;
  lastDetectedDate?: GoogleDate;
  warningEscalationDate?: GoogleDate;
  policyTopics?: Array<{ topic?: string; mustFix?: boolean; type?: string }>;
}

export function listPolicyIssues(account: string): Promise<PolicyIssue[]> {
  return listAll<PolicyIssue>(`${account}/policyIssues`, "policyIssues");
}

export interface Payment {
  name?: string;
  amount?: string;
  date?: GoogleDate;
}

export async function listPayments(account: string): Promise<Payment[]> {
  const res = await get<{ payments?: Payment[] }>(`${account}/payments`);
  return res.payments ?? [];
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

export interface ReportRequest {
  dateRange: DateRange;
  metrics: string[];
  dimensions?: string[];
  /** AdSense filter syntax, ANDed together: `COUNTRY_CODE==US`, `PAGE_URL=@/blog/`. */
  filters?: string[];
  /** `+METRIC` ascending or `-METRIC` descending. */
  orderBy?: string[];
  limit?: number;
  currencyCode?: string;
}

export interface ReportHeader {
  name: string;
  type: string;
  currencyCode?: string;
}

export interface ReportResponse {
  headers?: ReportHeader[];
  rows?: Array<{ cells?: Array<{ value?: string }> }>;
  totals?: { cells?: Array<{ value?: string }> };
  averages?: { cells?: Array<{ value?: string }> };
  totalMatchedRows?: string;
  warnings?: string[];
  startDate?: GoogleDate;
  endDate?: GoogleDate;
}

function setDate(qs: URLSearchParams, prefix: string, iso: string): void {
  const [y, m, d] = iso.split("-");
  qs.set(`${prefix}.year`, String(Number(y)));
  qs.set(`${prefix}.month`, String(Number(m)));
  qs.set(`${prefix}.day`, String(Number(d)));
}

export async function generateReport(account: string, req: ReportRequest): Promise<ReportResponse> {
  const qs = new URLSearchParams({ dateRange: "CUSTOM", reportingTimeZone: "ACCOUNT_TIME_ZONE" });
  setDate(qs, "startDate", req.dateRange.startDate);
  setDate(qs, "endDate", req.dateRange.endDate);
  for (const m of req.metrics) qs.append("metrics", m);
  for (const d of req.dimensions ?? []) qs.append("dimensions", d);
  for (const f of req.filters ?? []) qs.append("filters", f);
  for (const o of req.orderBy ?? []) qs.append("orderBy", o);
  if (req.limit) qs.set("limit", String(req.limit));
  if (req.currencyCode) qs.set("currencyCode", req.currencyCode);

  return get<ReportResponse>(`${account}/reports:generate`, qs);
}
