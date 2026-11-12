/**
 * The API wants `accounts/pub-1234567890123456`, but the publisher id shows up
 * in several shapes: bare `pub-…` from the AdSense UI, `ca-pub-…` from ad code
 * and ad client ids, and the prefixed form passed back from
 * adsense_list_accounts. Accept all of them rather than making the caller guess.
 */
export function normalizeAccountId(input: string): string {
  const bare = input
    .trim()
    .replace(/^accounts\//, "")
    .replace(/\/.*$/, "")
    .replace(/^ca-/, "");

  if (!/^pub-\d+$/.test(bare)) {
    throw new InvalidAccountError(input);
  }
  return `accounts/${bare}`;
}

/** Just `pub-…`, for display. */
export function accountNumber(input: string): string {
  return normalizeAccountId(input).replace(/^accounts\//, "");
}

export class InvalidAccountError extends Error {
  constructor(input: string) {
    super(
      `"${input}" is not an AdSense publisher id. Expected pub-1234567890123456 (ca-pub-… and ` +
        `accounts/pub-… are accepted too). Omit account entirely to use the only account this login ` +
        `can reach, or call adsense_list_accounts to see them.`,
    );
    this.name = "InvalidAccountError";
  }
}
