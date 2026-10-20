import { describe, expect, it } from 'vitest';
import { renderFailure, renderProgress } from './render-report.js';

describe('renderFailure', () => {
  const base = {
    stage: 'fixing',
    roundNo: 1,
    headSha: '19f3ec6d26113897eda36d1601321aa73bb89751',
    error: 'Error: agent fixer failed after 1 attempts: StreamStalledError: stream stalled',
    runUrl: 'https://github.com/o/r/actions/runs/1',
  };

  it('names the stage, round and head, and links the run', () => {
    const body = renderFailure(base);
    expect(body).toContain('`fixing` stage on round 1 (`19f3ec6d26`)');
    expect(body).toContain('StreamStalledError: stream stalled');
    expect(body).toContain('Full log: https://github.com/o/r/actions/runs/1');
  });

  it("keeps only the error's first line off the repo's command output", () => {
    const body = renderFailure({ ...base, error: 'Error: setup command failed:\nSECRET=hunter2 npm ERR!' });
    expect(body).toContain('setup command failed:');
    expect(body).not.toContain('hunter2');
  });

  it('cannot close its own code fence', () => {
    const body = renderFailure({ ...base, error: 'Error: bad ``` fence' });
    expect(body.match(/```/g)).toHaveLength(2);
  });

  it('omits what it does not know', () => {
    const body = renderFailure({ ...base, roundNo: null, headSha: null, runUrl: null });
    expect(body).toContain('in the `fixing` stage. The gate stays blocked');
    expect(body).not.toContain('Full log');
  });
});

describe('renderProgress', () => {
  const steps = [
    { at: '2026-10-20T18:25:09Z', text: 'Planning the fixes' },
    { at: '2026-10-20T18:33:40Z', text: 'Making the fixes (12 steps)' },
  ];

  it('marks earlier steps done and the latest in progress', () => {
    const body = renderProgress({ intro: '**Got it**', steps, finished: false });
    expect(body).toContain('- ✅ Planning the fixes · 18:25 UTC');
    expect(body).toContain('- ⏳ Making the fixes (12 steps) · 18:33 UTC');
    expect(body).toContain('updates as the review moves along');
  });

  it('marks every step done once finished, and drops the footer', () => {
    const body = renderProgress({ intro: '**Got it**', steps, finished: true });
    expect(body).not.toContain('⏳');
    expect(body).not.toContain('updates as the review moves along');
  });

  it('keeps a step its own icon wherever it sits', () => {
    const body = renderProgress({
      intro: '**Got it**',
      steps: [steps[0], { at: '2026-10-20T19:00:00Z', text: 'Stopped', icon: '⛔' }, steps[1]],
      finished: false,
    });
    expect(body).toContain('- ⛔ Stopped · 19:00 UTC');
    expect(body).toContain('- ⏳ Making the fixes');
  });
});
