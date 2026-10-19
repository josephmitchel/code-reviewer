import { describe, expect, it } from 'vitest';
import { renderFailure } from './render-report.js';

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
    expect(body).toContain('in the `fixing` stage. No gate status');
    expect(body).not.toContain('Full log');
  });
});
