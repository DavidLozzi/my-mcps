import { z } from "zod";

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export const accountField = z
  .string()
  .min(1)
  .optional()
  .describe("Account name or address from email_list_accounts. Omit for the default account.");

export const folderField = z
  .string()
  .min(1)
  .optional()
  .describe(
    "Folder path from email_list_folders, a folder name, or a role: inbox, sent, drafts, trash, spam, archive. " +
      "Defaults to INBOX.",
  );

export const idField = z.string().min(1).describe("Message id from email_list, email_search, or email_get_thread.");

export const idsField = z.array(z.string().min(1)).min(1).max(500).describe("Message ids, up to 500.");

export const dayField = z.string().regex(DAY, "Use YYYY-MM-DD.");

export const recipientsField = z
  .array(z.string().min(3))
  .describe('Addresses, either "jane@example.com" or "Jane Doe <jane@example.com>".');

export const attachmentPathsField = z
  .array(z.string().min(1))
  .max(20)
  .optional()
  .describe("Absolute paths of local files to attach.");

export const searchFields = {
  from: z.string().min(1).optional().describe("Sender address or name contains this."),
  to: z.string().min(1).optional().describe("To: contains this."),
  cc: z.string().min(1).optional().describe("Cc: contains this."),
  subject: z.string().min(1).optional().describe("Subject contains this."),
  body: z.string().min(1).optional().describe("Body text contains this."),
  text: z.string().min(1).optional().describe("Headers or body contain this — the broadest match."),
  since: dayField.optional().describe("Received on or after this day (YYYY-MM-DD)."),
  before: dayField.optional().describe("Received before this day (YYYY-MM-DD)."),
  unread: z.boolean().optional().describe("true for unread only, false for read only."),
  flagged: z.boolean().optional(),
  answered: z.boolean().optional().describe("Already replied to."),
  hasAttachment: z.boolean().optional().describe("Only messages with a real (non-inline) attachment."),
  keyword: z.string().min(1).optional().describe("Carries this custom keyword (see email_set_keywords)."),
  largerThanKb: z.number().positive().optional(),
  smallerThanKb: z.number().positive().optional(),
};

export const maxCharsField = z
  .number()
  .int()
  .min(200)
  .max(200000)
  .default(8000)
  .describe("Cap on body characters returned.");
