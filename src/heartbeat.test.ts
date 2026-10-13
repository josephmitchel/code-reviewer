import { afterEach, describe, expect, it, vi } from 'vitest';
import { heartbeatLine, markStage, resetHeartbeatForTests, startHeartbeat, track } from './heartbeat.js';

const T0 = Date.parse('2026-10-13T21:00:00Z');
const MIN = 60 * 1000;

afterEach(() => {
  resetHeartbeatForTests();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('heartbeatLine', () => {
  it('names the stage, its age and every agent with how long since it last spoke', () => {
    markStage('auditing', T0);
    let clock = T0 + MIN;
    const security = track('audit:security', () => clock);
    const tests = track('command "npm test"', () => clock);
    clock = T0 + 9 * MIN;
    security.output();
    expect(heartbeatLine(T0 + 14 * MIN + 20_000)).toBe(
      'still auditing (14m in this stage) — 2 running: ' +
        'audit:security 13m (last output 5m ago); command "npm test" 13m',
    );
    tests.done();
    security.done();
    expect(heartbeatLine(T0 + 90 * MIN)).toBe(
      'still auditing (1h30m in this stage) — no agent or command running',
    );
  });

  it('stays quiet while a local run waits on the owner with nothing in flight', () => {
    markStage('awaiting_answers', T0);
    expect(heartbeatLine(T0 + 30 * MIN)).toBeNull();
    const mapper = track('answers', () => T0);
    expect(heartbeatLine(T0 + 30 * MIN)).toBe(
      'still awaiting_answers (30m in this stage) — 1 running: answers 30m',
    );
    mapper.done();
  });
});

describe('startHeartbeat', () => {
  it('logs on the interval and stops when told', () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    markStage('synthesizing');
    const stop = startHeartbeat(2 * MIN);
    vi.advanceTimersByTime(4 * MIN);
    expect(log.mock.calls.map(([line]) => line)).toEqual([
      'still synthesizing (2m in this stage) — no agent or command running',
      'still synthesizing (4m in this stage) — no agent or command running',
    ]);
    stop();
    vi.advanceTimersByTime(10 * MIN);
    expect(log).toHaveBeenCalledTimes(2);
  });
});
