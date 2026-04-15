import { z } from 'zod';

/**
 * Accepts either a bare string (coerced to a single-element array) or an
 * explicit string array.  This allows the common YAML idiom of writing a
 * scalar value for a single link type name without requiring the operator to
 * wrap it in a list.
 */
const stringOrArray = z.union([
  z.string().min(1).transform((s) => [s]),
  z.array(z.string().min(1)),
]);

/**
 * Optional tenant-level Jira field configuration.
 * All fields have defaults that match the previously hardcoded values, so
 * omitting this stanza entirely leaves behaviour unchanged.
 */
export const JiraStanzaSchema = z.object({
  /** Custom field IDs to probe for story points, tried in priority order. */
  storyPointsFieldIds: z.array(z.string().min(1)).optional(),

  /**
   * Custom field ID for the legacy Epic Link field.
   * Set to null to disable the legacy fallback entirely (next-gen projects only).
   */
  epicLinkFieldId: z.string().min(1).nullable().optional(),

  /** Inward link type name substrings for JPD delivery links. */
  jpdDeliveryLinkInward: stringOrArray.optional(),

  /** Outward link type name substrings for JPD delivery links. */
  jpdDeliveryLinkOutward: stringOrArray.optional(),
});

export type JiraStanza = z.infer<typeof JiraStanzaSchema>;

const BoardYamlSchema = z.object({
  boardId: z.string().min(1).toUpperCase(),
  // boardType is optional — omitting it leaves the existing DB value untouched.
  // This allows partial YAML updates that only set field-level overrides without
  // re-declaring the board type on every entry.
  boardType: z.enum(['scrum', 'kanban']).optional(),
  // NOTE: doneStatusNames uses TypeORM `simple-array` storage (comma-delimited text).
  // Status names that contain a comma will be corrupted on DB roundtrip — use
  // simple-json storage (via the entity) if commas in status names are required.
  doneStatusNames: z.array(z.string()).optional(),
  inProgressStatusNames: z.array(z.string()).optional(),
  cancelledStatusNames: z.array(z.string()).optional(),
  failureIssueTypes: z.array(z.string()).optional(),
  failureLinkTypes: z.array(z.string()).optional(),
  failureLabels: z.array(z.string()).optional(),
  incidentIssueTypes: z.array(z.string()).optional(),
  recoveryStatusNames: z.array(z.string()).optional(),
  incidentLabels: z.array(z.string()).optional(),
  incidentPriorities: z.array(z.string()).optional(),
  backlogStatusIds: z.array(z.string()).optional(),
  dataStartDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'dataStartDate must be a date in YYYY-MM-DD format')
    .nullable()
    .optional(),
});

export const BoardsYamlFileSchema = z
  .object({
    boards: z.array(BoardYamlSchema),
    jira: JiraStanzaSchema.optional(),
  })
  .superRefine((data, ctx) => {
    const seen = new Set<string>();
    data.boards.forEach((b, i) => {
      if (seen.has(b.boardId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate boardId "${b.boardId}" at index ${i}`,
          path: ['boards', i, 'boardId'],
        });
      }
      seen.add(b.boardId);
    });
  });

export type BoardsYamlFile = z.infer<typeof BoardsYamlFileSchema>;
export type BoardYaml = z.infer<typeof BoardYamlSchema>;
