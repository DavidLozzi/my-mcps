import { getAccessToken, NotAuthenticatedError, PACKAGE_ROOT } from "./auth.js";
import { encodeSiteUrl, normalizeSiteUrl } from "./lib/site-url.js";

// Overridable so the analysis logic can be exercised against a stub API.
const BASE = process.env.GSC_API_BASE ?? "https://searchconsole.googleapis.com";

/** An API failure already phrased as something Claude can act on. */
export class GscApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "GscApiError";
  }
}

interface GoogleErrorBody {
  error?: { message?: string; status?: string };
}

async function request<T>(
  path: string,
  init: { method: string; body?: unknown },
): Promise<T> {
  const token = await getAccessToken();

  const res = await fetch(`${BASE}${path}`, {
    method: init.method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });

  if (res.ok) {
    // DELETE and PUT sitemap return 204 with an empty body.
    if (res.status === 204) return {} as T;
    const text = await res.text();
    return (text ? JSON.parse(text) : {}) as T;
  }

  const raw = await res.text();
  let googleMessage = raw.slice(0, 400);
  try {
    const parsed = JSON.parse(raw) as GoogleErrorBody;
    googleMessage = parsed.error?.message ?? googleMessage;
  } catch {
    /* Non-JSON error body; use the raw text. */
  }

  throw new GscApiError(await explain(res.status, googleMessage), res.status);
}

/**
 * Turn an HTTP status into a next step. A 403 in particular is almost always a
 * siteUrl-format mismatch rather than a real permission problem, so list the
 * properties the account can actually see.
 */
async function explain(status: number, googleMessage: string): Promise<string> {
  switch (status) {
    case 401:
      return (
        `Google rejected the credentials (401): ${googleMessage}\n\n` +
        `The token was revoked or expired. Re-authenticate:\n  cd ${PACKAGE_ROOT} && npm run auth`
      );

    case 403: {
      let accessible = "";
      try {
        const sites = await listSites();
        accessible =
          sites.length === 0
            ? "\n\nThis account has no Search Console properties at all."
            : `\n\nProperties this account can access (use one of these verbatim as siteUrl):\n` +
              sites.map((s) => `  ${s.siteUrl}`).join("\n");
      } catch {
        /* If the follow-up call also fails, the base message still stands. */
      }
      return (
        `Access denied (403): ${googleMessage}\n\n` +
        `Usually the siteUrl does not exactly match a property. URL-prefix properties ` +
        `need a trailing slash (https://example.com/); domain properties use the ` +
        `sc-domain:example.com form.${accessible}`
      );
    }

    case 404:
      return `Not found (404): ${googleMessage}\n\nCheck the siteUrl and, for sitemaps, that feedpath is the full sitemap URL.`;

    case 429:
      return (
        `Rate limited (429): ${googleMessage}\n\n` +
        `Search Console allows ~1200 queries/minute and 40,000/day per user. ` +
        `Narrow the date range or lower rowLimit, then retry.`
      );

    default:
      if (status >= 500) {
        return `Google returned ${status}: ${googleMessage}\n\nThis is a transient Google-side error; retrying usually works.`;
      }
      return `Search Console API error ${status}: ${googleMessage}`;
  }
}

export { NotAuthenticatedError };

// ---------------------------------------------------------------------------
// Sites
// ---------------------------------------------------------------------------

export interface SiteEntry {
  siteUrl: string;
  permissionLevel: string;
}

export async function listSites(): Promise<SiteEntry[]> {
  const res = await request<{ siteEntry?: SiteEntry[] }>("/webmasters/v3/sites", {
    method: "GET",
  });
  return res.siteEntry ?? [];
}

// ---------------------------------------------------------------------------
// Search Analytics
// ---------------------------------------------------------------------------

export type Dimension =
  | "DATE"
  | "QUERY"
  | "PAGE"
  | "COUNTRY"
  | "DEVICE"
  | "SEARCH_APPEARANCE"
  | "HOUR";

export type SearchType =
  | "WEB"
  | "IMAGE"
  | "VIDEO"
  | "NEWS"
  | "DISCOVER"
  | "GOOGLE_NEWS";

export interface DimensionFilter {
  dimension: "QUERY" | "PAGE" | "COUNTRY" | "DEVICE" | "SEARCH_APPEARANCE";
  operator:
    | "EQUALS"
    | "NOT_EQUALS"
    | "CONTAINS"
    | "NOT_CONTAINS"
    | "INCLUDING_REGEX"
    | "EXCLUDING_REGEX";
  expression: string;
}

export interface DimensionFilterGroup {
  groupType?: "AND";
  filters: DimensionFilter[];
}

export interface SearchAnalyticsQuery {
  siteUrl: string;
  startDate: string;
  endDate: string;
  dimensions?: Dimension[];
  type?: SearchType;
  dimensionFilterGroups?: DimensionFilterGroup[];
  aggregationType?: "AUTO" | "BY_PROPERTY" | "BY_PAGE" | "BY_NEWS_SHOWCASE_PANEL";
  dataState?: "FINAL" | "ALL" | "HOURLY_ALL";
  rowLimit?: number;
  startRow?: number;
}

export interface AnalyticsRow {
  keys?: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export async function searchAnalytics(
  query: SearchAnalyticsQuery,
): Promise<AnalyticsRow[]> {
  const { siteUrl, ...body } = query;
  const res = await request<{ rows?: AnalyticsRow[] }>(
    `/webmasters/v3/sites/${encodeSiteUrl(siteUrl)}/searchAnalytics/query`,
    { method: "POST", body },
  );
  return res.rows ?? [];
}

/** Hard ceiling on rows the API returns in one call. */
export const MAX_ROWS_PER_PAGE = 25_000;

/**
 * Page through Search Analytics until Google returns a short page or `maxRows`
 * is reached. The derived SEO tools need the full result set to compute
 * site-relative baselines, but an unbounded loop on a large property would
 * take minutes, so callers always pass a cap.
 */
export async function searchAnalyticsAll(
  query: Omit<SearchAnalyticsQuery, "rowLimit" | "startRow">,
  maxRows: number,
): Promise<AnalyticsRow[]> {
  const rows: AnalyticsRow[] = [];

  while (rows.length < maxRows) {
    const rowLimit = Math.min(MAX_ROWS_PER_PAGE, maxRows - rows.length);
    const page = await searchAnalytics({ ...query, rowLimit, startRow: rows.length });
    rows.push(...page);
    if (page.length < rowLimit) break;
  }

  return rows;
}

// ---------------------------------------------------------------------------
// Sitemaps
// ---------------------------------------------------------------------------

export interface SitemapContent {
  type: string;
  submitted?: string;
  indexed?: string;
}

export interface Sitemap {
  path: string;
  lastSubmitted?: string;
  lastDownloaded?: string;
  isPending?: boolean;
  isSitemapsIndex?: boolean;
  type?: string;
  warnings?: string;
  errors?: string;
  contents?: SitemapContent[];
}

export async function listSitemaps(
  siteUrl: string,
  sitemapIndex?: string,
): Promise<Sitemap[]> {
  const qs = sitemapIndex ? `?sitemapIndex=${encodeURIComponent(sitemapIndex)}` : "";
  const res = await request<{ sitemap?: Sitemap[] }>(
    `/webmasters/v3/sites/${encodeSiteUrl(siteUrl)}/sitemaps${qs}`,
    { method: "GET" },
  );
  return res.sitemap ?? [];
}

export async function getSitemap(siteUrl: string, feedpath: string): Promise<Sitemap> {
  return request<Sitemap>(
    `/webmasters/v3/sites/${encodeSiteUrl(siteUrl)}/sitemaps/${encodeURIComponent(feedpath)}`,
    { method: "GET" },
  );
}

export async function submitSitemap(siteUrl: string, feedpath: string): Promise<void> {
  await request<void>(
    `/webmasters/v3/sites/${encodeSiteUrl(siteUrl)}/sitemaps/${encodeURIComponent(feedpath)}`,
    { method: "PUT" },
  );
}

export async function deleteSitemap(siteUrl: string, feedpath: string): Promise<void> {
  await request<void>(
    `/webmasters/v3/sites/${encodeSiteUrl(siteUrl)}/sitemaps/${encodeURIComponent(feedpath)}`,
    { method: "DELETE" },
  );
}

// ---------------------------------------------------------------------------
// URL Inspection
// ---------------------------------------------------------------------------

export interface InspectionResult {
  inspectionResultLink?: string;
  indexStatusResult?: {
    verdict?: string;
    coverageState?: string;
    robotsTxtState?: string;
    indexingState?: string;
    lastCrawlTime?: string;
    pageFetchState?: string;
    googleCanonical?: string;
    userCanonical?: string;
    sitemap?: string[];
    referringUrls?: string[];
    crawledAs?: string;
  };
  mobileUsabilityResult?: {
    verdict?: string;
    issues?: Array<{ issueType?: string; severity?: string; message?: string }>;
  };
  richResultsResult?: {
    verdict?: string;
    detectedItems?: Array<{
      richResultType?: string;
      items?: Array<{
        name?: string;
        issues?: Array<{ issueMessage?: string; severity?: string }>;
      }>;
    }>;
  };
  ampResult?: { verdict?: string; ampUrl?: string };
}

export async function inspectUrl(
  siteUrl: string,
  inspectionUrl: string,
  languageCode?: string,
): Promise<InspectionResult> {
  const res = await request<{ inspectionResult?: InspectionResult }>(
    "/v1/urlInspection/index:inspect",
    {
      method: "POST",
      body: {
        siteUrl: normalizeSiteUrl(siteUrl),
        inspectionUrl,
        ...(languageCode ? { languageCode } : {}),
      },
    },
  );
  return res.inspectionResult ?? {};
}
