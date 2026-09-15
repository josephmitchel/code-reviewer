import { z } from 'zod';

export const CHARACTERISTICS = [
  'functional-suitability',
  'performance-efficiency',
  'compatibility',
  'interaction-capability',
  'reliability',
  'security',
  'maintainability',
  'flexibility',
  'safety',
  'testing',
] as const;

export const findingSchema = z.object({
  kind: z.enum(['prior_open', 'prior_fixed', 'new']),
  prior_slug: z.string().nullable(),
  title: z.string(),
  level: z.enum(['major', 'moderate', 'minor']),
  characteristics: z.array(z.string()),
  locations: z.array(z.object({ file: z.string(), line: z.number().nullable() })),
  body: z.string(),
});

export const auditorOutputSchema = z.object({
  findings: z.array(findingSchema),
  nothing_found: z.boolean(),
  notes: z.string().nullable(),
});
export type AuditorOutput = z.infer<typeof auditorOutputSchema>;

export const scoutOutputSchema = z.object({
  files: z.array(z.object({ path: z.string(), reason: z.string() })),
  pr_summary: z.string(),
});
export type ScoutOutput = z.infer<typeof scoutOutputSchema>;

export const synthesisOutputSchema = z.object({
  concerns: z.array(
    z.object({
      action: z.enum(['create', 'carry', 'resolve', 'reopen']),
      slug: z.string(),
      title: z.string(),
      level: z.enum(['major', 'moderate', 'minor']),
      characteristics: z.array(z.enum(CHARACTERISTICS)),
      locations: z.array(z.object({ file: z.string(), line: z.number().nullable() })),
      body: z.string(),
      introduced_by_fix: z.boolean(),
    }),
  ),
  questions: z.array(
    z.object({
      text: z.string(),
      concern_slug: z.string().nullable(),
      recommendation: z.string(),
      user_facing: z.boolean(),
    }),
  ),
  round_summary: z.string(),
});
export type SynthesisOutput = z.infer<typeof synthesisOutputSchema>;

export const fixPlanOutputSchema = z.object({
  steps: z.array(
    z.object({
      concern_slug: z.string(),
      approach: z.string(),
      files: z.array(z.string()),
    }),
  ),
  commit_message: z.string(),
});
export type FixPlanOutput = z.infer<typeof fixPlanOutputSchema>;

export const judgeOutputSchema = z.object({
  slug: z.string(),
  verdict: z.enum(['resolved', 'unresolved']),
  evidence: z.string(),
});
export type JudgeOutput = z.infer<typeof judgeOutputSchema>;

export const answersOutputSchema = z.object({
  answers: z.array(z.object({ ordinal: z.number(), answer: z.string() })),
  proceed: z.boolean(),
});
export type AnswersOutput = z.infer<typeof answersOutputSchema>;

export function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, { target: 'draft-7' }) as Record<string, unknown>;
}
