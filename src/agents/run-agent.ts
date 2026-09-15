import { query, type Options } from '@anthropic-ai/claude-agent-sdk';
import { eq } from 'drizzle-orm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { z } from 'zod';
import { db, schema } from '../db/client.js';
import { toJsonSchema } from './schemas.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export function loadPrompt(relPath: string, vars: Record<string, string> = {}): string {
  let text = fs.readFileSync(path.join(projectRoot, 'prompts', relPath), 'utf8');
  for (const [key, value] of Object.entries(vars)) {
    text = text.replaceAll(`{{${key}}}`, value);
  }
  const leftover = text.match(/\{\{[A-Z_]+\}\}/);
  if (leftover) throw new Error(`unfilled placeholder ${leftover[0]} in ${relPath}`);
  return text;
}

const READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob', 'Bash'];

export interface RunAgentParams<T> {
  roundId: number;
  role: string;
  prompt: string;
  cwd: string;
  outputSchema: z.ZodType<T>;
  model?: string; // default sonnet
  readOnly?: boolean; // default true; false grants Write/Edit
  maxRetries?: number; // default 1 retry after a failure
}

export interface AgentRunResult<T> {
  output: T;
  sessionRowId: number;
}

/** Returns the recorded successful result for (roundId, role) if one exists — the resume path. */
export async function priorSuccess<T>(
  roundId: number,
  role: string,
  outputSchema: z.ZodType<T>,
): Promise<AgentRunResult<T> | null> {
  const rows = await db
    .select()
    .from(schema.agentSessions)
    .where(eq(schema.agentSessions.roundId, roundId));
  const row = rows.find((r) => r.role === role && r.status === 'succeeded');
  if (!row) return null;
  const parsed = outputSchema.safeParse(row.result);
  if (!parsed.success) return null;
  return { output: parsed.data, sessionRowId: row.id };
}

export async function runAgent<T>(params: RunAgentParams<T>): Promise<AgentRunResult<T>> {
  const existing = await priorSuccess(params.roundId, params.role, params.outputSchema);
  if (existing) {
    console.log(`  [${params.role}] already succeeded — skipping`);
    return existing;
  }

  const attempts = 1 + (params.maxRetries ?? 1);
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const [row] = await db
      .insert(schema.agentSessions)
      .values({ roundId: params.roundId, role: params.role, status: 'running' })
      .returning();
    try {
      const result = await runOnce(params);
      const parsed = params.outputSchema.safeParse(result.structuredOutput);
      if (!parsed.success) {
        throw new Error(`structured output failed validation: ${parsed.error.message}`);
      }
      await db
        .update(schema.agentSessions)
        .set({
          status: 'succeeded',
          sdkSessionId: result.sdkSessionId,
          result: parsed.data,
          usage: result.usage,
          finishedAt: new Date(),
        })
        .where(eq(schema.agentSessions.id, row.id));
      return { output: parsed.data, sessionRowId: row.id };
    } catch (err) {
      lastError = err;
      await db
        .update(schema.agentSessions)
        .set({
          status: 'failed',
          isError: true,
          result: { error: String(err) },
          finishedAt: new Date(),
        })
        .where(eq(schema.agentSessions.id, row.id));
      console.error(`  [${params.role}] attempt ${attempt}/${attempts} failed: ${String(err)}`);
    }
  }
  throw new Error(`agent ${params.role} failed after ${attempts} attempts: ${String(lastError)}`);
}

interface RawRunResult {
  structuredOutput: unknown;
  sdkSessionId: string | null;
  usage: unknown;
}

async function runOnce<T>(params: RunAgentParams<T>): Promise<RawRunResult> {
  const readOnly = params.readOnly ?? true;
  const options: Options = {
    cwd: params.cwd,
    model: params.model ?? 'sonnet',
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    allowedTools: readOnly ? READ_ONLY_TOOLS : undefined,
    outputFormat: { type: 'json_schema', schema: toJsonSchema(params.outputSchema) },
  } as Options;

  let structuredOutput: unknown;
  let sdkSessionId: string | null = null;
  let usage: unknown = null;
  let resultSubtype: string | null = null;

  for await (const message of query({ prompt: params.prompt, options })) {
    if (message.type === 'system' && message.subtype === 'init') {
      sdkSessionId = (message as { session_id?: string }).session_id ?? null;
    }
    if (message.type === 'result') {
      const m = message as {
        subtype: string;
        structured_output?: unknown;
        usage?: unknown;
        session_id?: string;
      };
      resultSubtype = m.subtype;
      structuredOutput = m.structured_output;
      usage = m.usage ?? null;
      sdkSessionId = m.session_id ?? sdkSessionId;
    }
  }

  if (resultSubtype !== 'success') {
    throw new Error(`session ended with subtype ${resultSubtype ?? 'none'}`);
  }
  if (structuredOutput === undefined) {
    throw new Error('session succeeded but produced no structured output');
  }
  return { structuredOutput, sdkSessionId, usage };
}

/** Run up to `limit` promise factories concurrently. Rejects with the first error after all settle. */
export async function withConcurrency<T>(
  factories: Array<() => Promise<T>>,
  limit: number,
): Promise<T[]> {
  const results: T[] = new Array(factories.length);
  const errors: unknown[] = [];
  let next = 0;
  async function worker() {
    while (next < factories.length) {
      const i = next++;
      try {
        results[i] = await factories[i]();
      } catch (err) {
        errors.push(err);
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, factories.length) }, () => worker()),
  );
  if (errors.length > 0) throw errors[0];
  return results;
}
