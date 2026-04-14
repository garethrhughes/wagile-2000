import { z } from 'zod';

const RoadmapYamlSchema = z.object({
  jpdKey: z.string().min(1),
  description: z.string().nullable().optional(),
  startDateFieldId: z.string().nullable().optional(),
  targetDateFieldId: z.string().nullable().optional(),
});

export const RoadmapYamlFileSchema = z
  .object({
    roadmaps: z.array(RoadmapYamlSchema),
  })
  .superRefine((data, ctx) => {
    const seen = new Set<string>();
    data.roadmaps.forEach((r, i) => {
      if (seen.has(r.jpdKey)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate jpdKey "${r.jpdKey}" at index ${i}`,
          path: ['roadmaps', i, 'jpdKey'],
        });
      }
      seen.add(r.jpdKey);
    });
  });

export type RoadmapYamlFile = z.infer<typeof RoadmapYamlFileSchema>;
export type RoadmapYaml = z.infer<typeof RoadmapYamlSchema>;
