/**
 * Search Console accepts two property forms:
 *   - URL-prefix:      https://example.com/   (trailing slash is required)
 *   - Domain property: sc-domain:example.com
 *
 * Mismatching the form is by far the most common cause of a 403 on an
 * otherwise valid request, so normalize aggressively before sending.
 */

export function normalizeSiteUrl(siteUrl: string): string {
  const trimmed = siteUrl.trim();

  if (trimmed.startsWith("sc-domain:")) {
    return trimmed;
  }

  // A bare domain ("example.com") is ambiguous, but Search Console properties
  // are far more often registered as domain properties, so leave it to the API
  // to reject rather than guessing a scheme.
  if (!/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }

  return trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
}

/** Encode a normalized siteUrl for interpolation into a REST path segment. */
export function encodeSiteUrl(siteUrl: string): string {
  return encodeURIComponent(normalizeSiteUrl(siteUrl));
}
