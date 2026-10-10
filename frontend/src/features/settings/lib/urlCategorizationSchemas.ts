import { z } from "zod";

/** Where the UT1 category lists are downloaded from. */
export const sourceUrlSchema = z.object({
  source_url: z.string().trim().min(1, "source_url is required"),
});
export type SourceUrlValues = z.infer<typeof sourceUrlSchema>;

// The server receives the value as typed, so these only check for content without trimming it.
const notBlank = (value: string) => value.trim().length > 0;

/** One domain / URL-prefix category override. */
export const urlOverrideSchema = z.object({
  kind: z.enum(["domain", "url"]),
  value: z.string().refine(notBlank, "Domain or URL prefix is required"),
  category_key: z.string().refine(notBlank, "Category is required"),
  note: z.string(),
});
export type UrlOverrideValues = z.infer<typeof urlOverrideSchema>;
