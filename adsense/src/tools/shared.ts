/** Field schemas shared across tools. */
import { z } from "zod";
import { RANGE_PRESETS } from "../lib/dates.js";

export const accountField = z
  .string()
  .optional()
  .describe(
    "AdSense publisher id, e.g. pub-1234567890123456 (ca-pub-… and accounts/pub-… also work). " +
      "Omit to use the only account this login can reach.",
  );

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD");

/** Shared date/range fields. Explicit dates always beat the preset. */
export const dateFields = {
  startDate: dateSchema
    .optional()
    .describe("Start of the window, YYYY-MM-DD, in the account's time zone. Overrides `range` when set."),
  endDate: dateSchema
    .optional()
    .describe("End of the window, YYYY-MM-DD. Defaults to yesterday, since today's earnings are still accruing."),
  range: z
    .enum(RANGE_PRESETS)
    .optional()
    .describe(
      "Relative window used when startDate is omitted. Defaults to last_28_days. Multi-day presets end " +
        "yesterday; only today and month_to_date include today's partial numbers.",
    ),
};

/** Dimensions the comparison and breakdown tools can group by. */
export const BREAKDOWN_DIMENSIONS = [
  "PAGE_URL",
  "DOMAIN_NAME",
  "OWNED_SITE_DOMAIN_NAME",
  "AD_UNIT_NAME",
  "COUNTRY_NAME",
  "PLATFORM_TYPE_NAME",
  "AD_FORMAT_NAME",
  "CUSTOM_CHANNEL_NAME",
  "URL_CHANNEL_NAME",
  "BUYER_NETWORK_NAME",
] as const;

export const breakdownDimensionField = z
  .enum(BREAKDOWN_DIMENSIONS)
  .describe(
    "What to break earnings down by. PAGE_URL is the individual page; DOMAIN_NAME the (sub)domain the ad " +
      "served on; OWNED_SITE_DOMAIN_NAME the site as registered in AdSense; PLATFORM_TYPE_NAME is " +
      "desktop/mobile/tablet.",
  );

/** Upper-case and trim, so `estimated_earnings` still works. */
export function apiName(name: string): string {
  return name.trim().toUpperCase();
}
