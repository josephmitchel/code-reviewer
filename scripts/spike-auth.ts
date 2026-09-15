// Milestone 0: prove the Agent SDK runs on Claude subscription auth (no API key),
// and that structured output via outputFormat works.
import { query } from '@anthropic-ai/claude-agent-sdk';

delete process.env.ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_AUTH_TOKEN;

async function main() {
  console.log('--- test 1: plain query, no API key in env ---');
  for await (const message of query({
    prompt: 'Reply with exactly the word OK and nothing else.',
    options: { maxTurns: 1 },
  })) {
    if (message.type === 'result') {
      console.log('subtype:', message.subtype);
      if (message.subtype === 'success') console.log('result:', message.result);
      console.log('usage:', JSON.stringify(message.usage ?? null));
      console.log('cost_usd:', (message as { total_cost_usd?: number }).total_cost_usd ?? 'n/a');
    } else if (message.type === 'system' && message.subtype === 'init') {
      console.log('model:', (message as { model?: string }).model);
    }
  }

  console.log('--- test 2: structured output (json_schema) ---');
  const schema = {
    type: 'object',
    properties: {
      findings: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            level: { enum: ['major', 'moderate', 'minor'] },
          },
          required: ['title', 'level'],
          additionalProperties: false,
        },
      },
      nothing_found: { type: 'boolean' },
    },
    required: ['findings', 'nothing_found'],
    additionalProperties: false,
  };
  for await (const message of query({
    prompt:
      'Invent two fake code-review findings (one major, one minor) about a hypothetical file. Return them via the structured output.',
    options: { maxTurns: 1, outputFormat: { type: 'json_schema', schema } } as never,
  })) {
    if (message.type === 'result') {
      console.log('subtype:', message.subtype);
      const structured = (message as { structured_output?: unknown }).structured_output;
      console.log('structured_output:', JSON.stringify(structured, null, 2));
    }
  }
}

main().catch((err) => {
  console.error('SPIKE FAILED:', err);
  process.exit(1);
});
