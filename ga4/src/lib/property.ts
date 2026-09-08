/**
 * The API wants `properties/123456789`, but people copy the bare numeric id out
 * of the GA4 UI, and Claude will sometimes pass the prefixed form back from
 * ga4_list_properties. Accept both rather than making the caller guess.
 */
export function normalizePropertyId(input: string): string {
  const trimmed = input.trim();
  const bare = trimmed.replace(/^properties\//, "");

  if (!/^\d+$/.test(bare)) {
    throw new InvalidPropertyError(input);
  }
  return `properties/${bare}`;
}

/** Just the digits, for display and for the metadata path. */
export function propertyNumber(input: string): string {
  return normalizePropertyId(input).replace(/^properties\//, "");
}

export class InvalidPropertyError extends Error {
  constructor(input: string) {
    super(
      `"${input}" is not a GA4 property id. Expected the numeric id (e.g. 123456789) or the ` +
        `prefixed form (properties/123456789). A measurement id like G-XXXXXXX will not work — ` +
        `call ga4_list_properties to get the numeric id.`,
    );
    this.name = "InvalidPropertyError";
  }
}
