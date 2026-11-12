/** An error whose message is already written for the user, shown as-is. */
export class ZohoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZohoError";
  }
}

interface ImapLikeError {
  code?: string;
  responseText?: string;
  serverResponseCode?: string;
  authenticationFailed?: boolean;
  responseCode?: number;
  command?: string;
}

/**
 * Turn an IMAP, SMTP, or socket failure into something that says what to do.
 * Anything unrecognised keeps its own message.
 */
export function describeError(err: unknown): string {
  if (err instanceof ZohoError) return err.message;
  const e = (err ?? {}) as ImapLikeError & Error;
  const text = `${e.responseText ?? ""} ${e.message ?? ""}`;

  if (e.authenticationFailed || e.serverResponseCode === "AUTHENTICATIONFAILED" || e.code === "EAUTH") {
    return (
      "Zoho rejected the login. Check that (1) IMAP access is enabled in Zoho Mail > Settings > Mail Accounts > " +
      "IMAP, (2) the password is an app-specific password from accounts.zoho.com > Security > App Passwords, not " +
      "your account password, and (3) your plan includes IMAP/SMTP — Zoho's Forever Free plan does not. Re-run " +
      "`npm run auth` in the zoho server directory to replace the stored password."
    );
  }
  if (e.code === "ENOTFOUND" || e.code === "ECONNREFUSED" || e.code === "ETIMEDOUT" || e.code === "ECONNRESET") {
    return `Could not reach the Zoho mail server (${e.code}). Check the network, and the imapHost/smtpHost for this account.`;
  }
  if (e.code === "NoConnection" || e.code === "ConnectionClosed") {
    return "The connection to Zoho dropped. Retry — the server reconnects on the next call.";
  }
  if (e.serverResponseCode === "NONEXISTENT" || /mailbox.*(not exist|doesn't exist|unknown)|no such/i.test(text)) {
    return "That folder does not exist. email_list_folders shows the exact folder paths.";
  }
  if (e.serverResponseCode === "ALREADYEXISTS") {
    return "A folder with that name already exists.";
  }
  if (e.serverResponseCode === "OVERQUOTA" || /quota/i.test(text)) {
    return "The mailbox is over its storage quota. Empty Trash/Spam or delete large messages first.";
  }
  if (typeof e.responseCode === "number" && e.responseCode >= 500) {
    return `Zoho SMTP refused the message: ${e.message}`;
  }
  return e.message ? `${e.message}${e.responseText && !e.message.includes(e.responseText) ? ` (${e.responseText})` : ""}` : String(err);
}
