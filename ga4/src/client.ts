import { getAccessToken, NotAuthenticatedError, PACKAGE_ROOT } from "./auth.js";
import { normalizePropertyId, propertyNumber } from "./lib/property.js";

// Overridable so the analysis logic can be exercised against a stub API.
const DATA_BASE = process.env.GA4_DATA_API_BASE ?? "https://analyticsdata.googleapis.com";
const ADMIN_BASE = process.env.GA4_ADMIN_API_BASE ?? "https://analyticsadmin.googleapis.com";

/** An API failure already phrased as something Claude can act on. */
export class Ga4ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "Ga4ApiError";
  }
}

interface GoogleErrorBody {
  error?: { message?: string; status?: string };
}

async function request<T>(
  base: string,
  path: string,
  init: { method: string; body?: unknown },
): Promise<T> {
  const token = await getAccessToken();

  const res = await fetch(`${base}${path}`, {
    method: init.method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
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

  throw new Ga4ApiError(await explain(res.status, googleMessage), res.status);
}

/**
 * Turn an HTTP status into a next step. GA4's most common failure by far is a
 * 400 over a dimension or metric name that does not exist or cannot be queried
 * alongside the others, so that case points at the two tools that resolve it.
 */
async function explain(status: number, googleMessage: string): Promise<string> {
  switch (status) {
    case 400:
      return (
        `Bad request (400): ${googleMessage}\n\n` +
        `Usually a dimension or metric name that does not exist on this property, or a ` +
        `combination GA4 refuses to join. Field names are camelCase API names (activeUsers, ` +
        `sessionDefaultChannelGroup), not UI labels. Call ga4_get_metadata to see the exact names ` +
        `this property supports — including its custom dimensions — and ga4_check_compatibility to ` +
        `test a combination before running the full report.`
      );

    case 401:
      return (
        `Google rejected the credentials (401): ${googleMessage}\n\n` +
        `The token was revoked or expired. Re-authenticate:\n  cd ${PACKAGE_ROOT} && npm run auth`
      );

    case 403: {
      let accessible = "";
      try {
        const accounts = await listProperties();
        const properties = accounts.flatMap((a) =>
          (a.propertySummaries ?? []).map((p) => ({
            id: (p.property ?? "").replace(/^properties\//, ""),
            name: p.displayName ?? "(unnamed)",
            account: a.displayName ?? "(unnamed account)",
          })),
        );
        accessible =
          properties.length === 0
            ? "\n\nThis account has no Google Analytics properties at all."
            : `\n\nProperties this account can access (pass the numeric id as propertyId):\n` +
              properties.map((p) => `  ${p.id.padEnd(12)} ${p.name}  [${p.account}]`).join("\n");
      } catch {
        /* If the follow-up call also fails, the base message still stands. */
      }
      return (
        `Access denied (403): ${googleMessage}\n\n` +
        `Either this Google account has no access to that property, or the required API is not ` +
        `enabled in the Cloud project that owns the OAuth client (enable both the Google Analytics ` +
        `Data API and the Google Analytics Admin API).${accessible}`
      );
    }

    case 404:
      return (
        `Not found (404): ${googleMessage}\n\n` +
        `Check the propertyId — it is the numeric property id from ga4_list_properties, not a ` +
        `G-XXXXXXX measurement id and not the account id.`
      );

    case 429:
      return (
        `Quota exhausted (429): ${googleMessage}\n\n` +
        `Standard GA4 properties allow 200,000 core tokens/day, 40,000/hour, and 14,000/hour per ` +
        `project, with 10 concurrent requests. A request costs more tokens the more rows, ` +
        `dimensions, and days it spans — shorten the date range, lower rowLimit, or drop a ` +
        `dimension, then retry.`
      );

    default:
      if (status >= 500) {
        return `Google returned ${status}: ${googleMessage}\n\nThis is a transient Google-side error; retrying usually works.`;
      }
      return `Google Analytics API error ${status}: ${googleMessage}`;
  }
}

export { NotAuthenticatedError };

// ---------------------------------------------------------------------------
// Admin API — properties and configuration
// ---------------------------------------------------------------------------

export interface PropertySummary {
  property?: string;
  displayName?: string;
  propertyType?: string;
  parent?: string;
}

export interface AccountSummary {
  name?: string;
  account?: string;
  displayName?: string;
  propertySummaries?: PropertySummary[];
}

export async function listProperties(): Promise<AccountSummary[]> {
  const accounts: AccountSummary[] = [];
  let pageToken: string | undefined;

  do {
    const qs = new URLSearchParams({ pageSize: "200" });
    if (pageToken) qs.set("pageToken", pageToken);
    const res = await request<{ accountSummaries?: AccountSummary[]; nextPageToken?: string }>(
      ADMIN_BASE,
      `/v1beta/accountSummaries?${qs}`,
      { method: "GET" },
    );
    accounts.push(...(res.accountSummaries ?? []));
    pageToken = res.nextPageToken;
  } while (pageToken);

  return accounts;
}

export interface Property {
  name?: string;
  displayName?: string;
  propertyType?: string;
  createTime?: string;
  timeZone?: string;
  currencyCode?: string;
  industryCategory?: string;
  serviceLevel?: string;
  account?: string;
}

export async function getProperty(propertyId: string): Promise<Property> {
  return request<Property>(ADMIN_BASE, `/v1beta/${normalizePropertyId(propertyId)}`, {
    method: "GET",
  });
}

export interface DataStream {
  name?: string;
  displayName?: string;
  type?: string;
  createTime?: string;
  webStreamData?: { measurementId?: string; defaultUri?: string };
  androidAppStreamData?: { packageName?: string; firebaseAppId?: string };
  iosAppStreamData?: { bundleId?: string; firebaseAppId?: string };
}

export interface KeyEvent {
  name?: string;
  eventName?: string;
  countingMethod?: string;
  createTime?: string;
  custom?: boolean;
  deletable?: boolean;
  defaultValue?: { numericValue?: number; currencyCode?: string };
}

export interface CustomDimension {
  name?: string;
  parameterName?: string;
  displayName?: string;
  description?: string;
  scope?: string;
  disallowAdsPersonalization?: boolean;
}

export interface CustomMetric {
  name?: string;
  parameterName?: string;
  displayName?: string;
  description?: string;
  measurementUnit?: string;
  scope?: string;
}

export interface DataRetentionSettings {
  name?: string;
  eventDataRetention?: string;
  resetUserDataOnNewActivity?: boolean;
}

/**
 * Admin list endpoints all share the shape `{ <collection>: [...], nextPageToken }`.
 * A missing collection means "none configured", which is a real answer here —
 * a property with no key events explains why conversion tools return zeros.
 */
async function listAdmin<T>(
  propertyId: string,
  collection: string,
): Promise<T[]> {
  const items: T[] = [];
  let pageToken: string | undefined;

  do {
    const qs = new URLSearchParams({ pageSize: "200" });
    if (pageToken) qs.set("pageToken", pageToken);
    const res = await request<Record<string, unknown>>(
      ADMIN_BASE,
      `/v1beta/${normalizePropertyId(propertyId)}/${collection}?${qs}`,
      { method: "GET" },
    );
    items.push(...((res[collection] as T[] | undefined) ?? []));
    pageToken = res.nextPageToken as string | undefined;
  } while (pageToken);

  return items;
}

export const listDataStreams = (propertyId: string) =>
  listAdmin<DataStream>(propertyId, "dataStreams");
export const listKeyEvents = (propertyId: string) =>
  listAdmin<KeyEvent>(propertyId, "keyEvents");
export const listCustomDimensions = (propertyId: string) =>
  listAdmin<CustomDimension>(propertyId, "customDimensions");
export const listCustomMetrics = (propertyId: string) =>
  listAdmin<CustomMetric>(propertyId, "customMetrics");

export async function getDataRetention(propertyId: string): Promise<DataRetentionSettings> {
  return request<DataRetentionSettings>(
    ADMIN_BASE,
    `/v1beta/${normalizePropertyId(propertyId)}/dataRetentionSettings`,
    { method: "GET" },
  );
}

// ---------------------------------------------------------------------------
// Data API — metadata
// ---------------------------------------------------------------------------

export interface DimensionMetadata {
  apiName?: string;
  uiName?: string;
  description?: string;
  customDefinition?: boolean;
  category?: string;
  deprecatedApiNames?: string[];
}

export interface MetricMetadata {
  apiName?: string;
  uiName?: string;
  description?: string;
  type?: string;
  expression?: string;
  customDefinition?: boolean;
  category?: string;
  deprecatedApiNames?: string[];
}

export interface Metadata {
  name?: string;
  dimensions?: DimensionMetadata[];
  metrics?: MetricMetadata[];
}

export async function getMetadata(propertyId: string): Promise<Metadata> {
  return request<Metadata>(
    DATA_BASE,
    `/v1beta/properties/${propertyNumber(propertyId)}/metadata`,
    { method: "GET" },
  );
}

// ---------------------------------------------------------------------------
// Data API — reports
// ---------------------------------------------------------------------------

export interface StringFilter {
  matchType?: "EXACT" | "BEGINS_WITH" | "ENDS_WITH" | "CONTAINS" | "FULL_REGEXP" | "PARTIAL_REGEXP";
  value: string;
  caseSensitive?: boolean;
}

export interface NumericValue {
  int64Value?: string;
  doubleValue?: number;
}

export interface Filter {
  fieldName: string;
  stringFilter?: StringFilter;
  inListFilter?: { values: string[]; caseSensitive?: boolean };
  numericFilter?: {
    operation: "EQUAL" | "LESS_THAN" | "LESS_THAN_OR_EQUAL" | "GREATER_THAN" | "GREATER_THAN_OR_EQUAL";
    value: NumericValue;
  };
  betweenFilter?: { fromValue: NumericValue; toValue: NumericValue };
}

export interface FilterExpression {
  andGroup?: { expressions: FilterExpression[] };
  orGroup?: { expressions: FilterExpression[] };
  notExpression?: FilterExpression;
  filter?: Filter;
}

export interface OrderBy {
  desc?: boolean;
  metric?: { metricName: string };
  dimension?: { dimensionName: string; orderType?: string };
}

export interface ReportRequest {
  propertyId: string;
  dimensions?: string[];
  metrics: string[];
  startDate: string;
  endDate: string;
  dimensionFilter?: FilterExpression;
  metricFilter?: FilterExpression;
  orderBys?: OrderBy[];
  limit?: number;
  offset?: number;
  metricAggregations?: Array<"TOTAL" | "MINIMUM" | "MAXIMUM" | "COUNT">;
  keepEmptyRows?: boolean;
  currencyCode?: string;
}

export interface ReportRow {
  dimensionValues?: Array<{ value?: string }>;
  metricValues?: Array<{ value?: string }>;
}

export interface PropertyQuota {
  tokensPerDay?: { consumed?: number; remaining?: number };
  tokensPerHour?: { consumed?: number; remaining?: number };
  concurrentRequests?: { consumed?: number; remaining?: number };
  serverErrorsPerProjectPerPropertyPerHour?: { consumed?: number; remaining?: number };
  potentiallyThresholdedRequestsPerHour?: { consumed?: number; remaining?: number };
  tokensPerProjectPerHour?: { consumed?: number; remaining?: number };
}

export interface ReportResponse {
  dimensionHeaders?: Array<{ name?: string }>;
  metricHeaders?: Array<{ name?: string; type?: string }>;
  rows?: ReportRow[];
  totals?: ReportRow[];
  rowCount?: number;
  metadata?: {
    dataLossFromOtherRow?: boolean;
    subjectToThresholding?: boolean;
    currencyCode?: string;
    timeZone?: string;
    emptyReason?: string;
    samplingMetadatas?: Array<{ samplesReadCount?: string; samplingSpaceSize?: string }>;
  };
  propertyQuota?: PropertyQuota;
  kind?: string;
}

/** Hard ceiling the Data API places on rows returned in one call. */
export const MAX_ROWS_PER_PAGE = 250_000;

function reportBody(req: ReportRequest): Record<string, unknown> {
  return {
    dimensions: (req.dimensions ?? []).map((name) => ({ name })),
    metrics: req.metrics.map((name) => ({ name })),
    dateRanges: [{ startDate: req.startDate, endDate: req.endDate }],
    ...(req.dimensionFilter ? { dimensionFilter: req.dimensionFilter } : {}),
    ...(req.metricFilter ? { metricFilter: req.metricFilter } : {}),
    ...(req.orderBys ? { orderBys: req.orderBys } : {}),
    ...(req.limit === undefined ? {} : { limit: String(req.limit) }),
    ...(req.offset === undefined ? {} : { offset: String(req.offset) }),
    ...(req.metricAggregations ? { metricAggregations: req.metricAggregations } : {}),
    ...(req.keepEmptyRows === undefined ? {} : { keepEmptyRows: req.keepEmptyRows }),
    ...(req.currencyCode ? { currencyCode: req.currencyCode } : {}),
    // Always on: the render layer only surfaces it when a bucket runs low, and
    // hitting a quota wall with no warning is the worst way to learn about it.
    returnPropertyQuota: true,
  };
}

export async function runReport(req: ReportRequest): Promise<ReportResponse> {
  return request<ReportResponse>(
    DATA_BASE,
    `/v1beta/${normalizePropertyId(req.propertyId)}:runReport`,
    { method: "POST", body: reportBody(req) },
  );
}

/**
 * Page through a report until Google returns a short page or `maxRows` is
 * reached. The derived analysis tools need the full result set to compute
 * property-relative baselines, but an unbounded loop on a large property would
 * take minutes and burn quota, so callers always pass a cap.
 */
export async function runReportAll(
  req: Omit<ReportRequest, "limit" | "offset">,
  maxRows: number,
): Promise<ReportResponse> {
  const rows: ReportRow[] = [];
  let last: ReportResponse = {};

  while (rows.length < maxRows) {
    const limit = Math.min(MAX_ROWS_PER_PAGE, maxRows - rows.length);
    const page = await runReport({ ...req, limit, offset: rows.length });
    last = page;
    const pageRows = page.rows ?? [];
    rows.push(...pageRows);
    if (pageRows.length < limit) break;
  }

  return { ...last, rows };
}

export interface RealtimeRequest {
  propertyId: string;
  dimensions?: string[];
  metrics: string[];
  minuteRanges?: Array<{ startMinutesAgo?: number; endMinutesAgo?: number }>;
  dimensionFilter?: FilterExpression;
  orderBys?: OrderBy[];
  limit?: number;
}

export async function runRealtimeReport(req: RealtimeRequest): Promise<ReportResponse> {
  return request<ReportResponse>(
    DATA_BASE,
    `/v1beta/${normalizePropertyId(req.propertyId)}:runRealtimeReport`,
    {
      method: "POST",
      body: {
        dimensions: (req.dimensions ?? []).map((name) => ({ name })),
        metrics: req.metrics.map((name) => ({ name })),
        ...(req.minuteRanges ? { minuteRanges: req.minuteRanges } : {}),
        ...(req.dimensionFilter ? { dimensionFilter: req.dimensionFilter } : {}),
        ...(req.orderBys ? { orderBys: req.orderBys } : {}),
        ...(req.limit === undefined ? {} : { limit: String(req.limit) }),
        returnPropertyQuota: true,
      },
    },
  );
}

export interface Compatibility {
  dimensionMetadata?: DimensionMetadata;
  metricMetadata?: MetricMetadata;
  compatibility?: "COMPATIBLE" | "INCOMPATIBLE";
}

export interface CompatibilityResponse {
  dimensionCompatibilities?: Compatibility[];
  metricCompatibilities?: Compatibility[];
}

export async function checkCompatibility(
  propertyId: string,
  dimensions: string[],
  metrics: string[],
): Promise<CompatibilityResponse> {
  return request<CompatibilityResponse>(
    DATA_BASE,
    `/v1beta/${normalizePropertyId(propertyId)}:checkCompatibility`,
    {
      method: "POST",
      body: {
        dimensions: dimensions.map((name) => ({ name })),
        metrics: metrics.map((name) => ({ name })),
        compatibilityFilter: "COMPATIBLE",
      },
    },
  );
}

// ---------------------------------------------------------------------------
// Data API v1alpha — funnels
// ---------------------------------------------------------------------------

export interface FunnelStepSpec {
  name: string;
  /** Matched against eventName, or against a page path when `pagePath` is set. */
  eventName?: string;
  pagePath?: string;
}

export interface FunnelSubReport {
  dimensionHeaders?: Array<{ name?: string }>;
  metricHeaders?: Array<{ name?: string; type?: string }>;
  rows?: ReportRow[];
  metadata?: { samplingMetadatas?: unknown[] };
}

export interface FunnelResponse {
  funnelTable?: FunnelSubReport;
  funnelVisualization?: FunnelSubReport;
  propertyQuota?: PropertyQuota;
}

function stepFilter(step: FunnelStepSpec): Record<string, unknown> {
  if (step.pagePath) {
    return {
      funnelFieldFilter: {
        fieldName: "pagePath",
        stringFilter: { matchType: "CONTAINS", value: step.pagePath },
      },
    };
  }
  return {
    funnelEventFilter: { eventName: step.eventName ?? step.name },
  };
}

export async function runFunnelReport(
  propertyId: string,
  steps: FunnelStepSpec[],
  startDate: string,
  endDate: string,
  breakdownDimension?: string,
): Promise<FunnelResponse> {
  return request<FunnelResponse>(
    DATA_BASE,
    `/v1alpha/${normalizePropertyId(propertyId)}:runFunnelReport`,
    {
      method: "POST",
      body: {
        dateRanges: [{ startDate, endDate }],
        funnel: {
          steps: steps.map((step) => ({
            name: step.name,
            filterExpression: { expr: stepFilter(step) },
          })),
        },
        ...(breakdownDimension
          ? {
              funnelBreakdown: {
                breakdownDimension: { name: breakdownDimension },
                limit: "5",
              },
            }
          : {}),
        returnPropertyQuota: true,
      },
    },
  );
}
