import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ENVIRONMENT_TIMEOUT_MS,
  EnvironmentUnavailableError,
  STALL_TIMEOUT_MS,
  StallWatch,
  StreamStalledError,
  isConnectionRetry,
} from './run-agent.js';

/**
 * The guard these cover exists because a stalled SDK stream is silent rather than broken:
 * the socket stays ESTABLISHED with empty queues, so a bare `for await` waits forever and
 * the whole review loop hangs behind one agent. The hard part is that a sleeping laptop
 * and a dead stream look the same from inside the loop — PR #12 lost an hour to exactly
 * that confusion. Fake timers keep the budgets symbolic; what matters is which side of
 * the race wins.
 */

/** The frame the CLI really emits for a dropped connection, captured from a live run. */
const CONNECTION_RETRY = {
  type: 'system',
  subtype: 'api_retry',
  attempt: 1,
  max_retries: 10,
  retry_delay_ms: 598,
  error_status: null,
  error: 'unknown',
};

const never = () => new Promise<string>(() => {});

/** Lets a promise rejection be observed without awaiting it, so we can assert "still waiting". */
function watchSettled(p: Promise<unknown>) {
  const state = { settled: false, err: undefined as unknown };
  void p.then(
    () => {
      state.settled = true;
    },
    (e) => {
      state.settled = true;
      state.err = e;
    },
  );
  return state;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('StallWatch', () => {
  it('passes a value through when the stream answers inside the budget', async () => {
    const watch = new StallWatch('scout', STALL_TIMEOUT_MS);
    await expect(watch.next(Promise.resolve('frame'))).resolves.toBe('frame');
  });

  it('rejects once the stream has been silent for the whole budget', async () => {
    vi.useFakeTimers();
    const watch = new StallWatch('fixer', STALL_TIMEOUT_MS);
    const race = watch.next(never());
    const state = watchSettled(race);

    await vi.advanceTimersByTimeAsync(STALL_TIMEOUT_MS - 30_000);
    expect(state.settled).toBe(false); // one heartbeat short: still waiting

    await vi.advanceTimersByTimeAsync(30_000);
    await expect(race).rejects.toBeInstanceOf(StreamStalledError);
  });

  it('restarts the budget on every frame, so a slow but live stream survives', async () => {
    vi.useFakeTimers();
    const watch = new StallWatch('synthesis', STALL_TIMEOUT_MS);
    // Six steps of 10 minutes: an hour total, four times the budget, but no single
    // silence reaches it. A total-runtime cap would kill this run; this must not.
    for (let i = 0; i < 6; i++) {
      const step = watch.next(
        new Promise<number>((resolve) => setTimeout(() => resolve(i), 600_000)),
      );
      await vi.advanceTimersByTimeAsync(600_000);
      await expect(step).resolves.toBe(i);
      watch.note({ type: 'assistant' });
    }
  });

  it('does not charge the agent for time the machine spent asleep', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const watch = new StallWatch('auditor-compatibility', STALL_TIMEOUT_MS);
    const race = watch.next(never());
    const state = watchSettled(race);

    // Freeze the process for an hour: wall-clock jumps, but the pending heartbeat only
    // gets to run afterwards — exactly what a closed lid does to a timer.
    vi.setSystemTime(Date.now() + 60 * 60_000);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(state.settled).toBe(false); // an hour asleep is not an hour of stalling
    expect(watch.suspendedMs).toBeGreaterThanOrEqual(60 * 60_000);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('of system suspend'));

    // It still holds the agent to a full budget of *awake* silence after waking.
    await vi.advanceTimersByTimeAsync(STALL_TIMEOUT_MS - 60_000);
    expect(state.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(race).rejects.toBeInstanceOf(StreamStalledError);
  });

  it('gives up early, and blames the network, when only connection retries arrive', async () => {
    vi.useFakeTimers();
    const watch = new StallWatch('auditor-functional-suitability', STALL_TIMEOUT_MS);
    for (let i = 0; i < 3; i++) watch.note(CONNECTION_RETRY);

    const race = watch.next(never());
    const state = watchSettled(race);

    await vi.advanceTimersByTimeAsync(ENVIRONMENT_TIMEOUT_MS - 30_000);
    expect(state.settled).toBe(false);

    await vi.advanceTimersByTimeAsync(30_000); // 5m, not the 15m stall budget
    await expect(race).rejects.toBeInstanceOf(EnvironmentUnavailableError);
    await expect(race).rejects.toThrow(/3 connection retries/);
  });

  it('treats a retry that got an HTTP status as progress, not as a dead network', async () => {
    vi.useFakeTimers();
    const watch = new StallWatch('judge', STALL_TIMEOUT_MS);
    // A 429 is the server answering; the CLI backs off and recovers on its own.
    watch.note({ ...CONNECTION_RETRY, error_status: 429, error: 'rate_limit' });

    const race = watch.next(never());
    const state = watchSettled(race);
    await vi.advanceTimersByTimeAsync(ENVIRONMENT_TIMEOUT_MS + 60_000);
    expect(state.settled).toBe(false); // still on the long budget

    await vi.advanceTimersByTimeAsync(STALL_TIMEOUT_MS);
    await expect(race).rejects.toBeInstanceOf(StreamStalledError);
  });

  it('returns to the full budget once the stream makes progress again', async () => {
    vi.useFakeTimers();
    const watch = new StallWatch('fixer', STALL_TIMEOUT_MS);
    watch.note(CONNECTION_RETRY);
    watch.note({ type: 'assistant' }); // reconnected

    const race = watch.next(never());
    const state = watchSettled(race);
    await vi.advanceTimersByTimeAsync(ENVIRONMENT_TIMEOUT_MS + 60_000);
    expect(state.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(STALL_TIMEOUT_MS);
    await expect(race).rejects.toBeInstanceOf(StreamStalledError);
  });

  it('never stretches a budget shorter than the environment one', async () => {
    vi.useFakeTimers();
    const watch = new StallWatch('selftest', 3_000); // the tiny budget used for self-tests
    watch.note(CONNECTION_RETRY);
    const race = watch.next(never());
    watchSettled(race); // attach now: an assertion added later counts as an unhandled rejection
    await vi.advanceTimersByTimeAsync(3_000);
    await expect(race).rejects.toBeInstanceOf(EnvironmentUnavailableError);
  });

  it('does not mask a genuine stream error as a stall', async () => {
    const boom = new Error('sdk exploded');
    const watch = new StallWatch('scout', STALL_TIMEOUT_MS);
    await expect(watch.next(Promise.reject(boom))).rejects.toBe(boom);
  });

  it('swallows the abandoned step, so closing the query raises no unhandled rejection', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      // The real sequence: we give up on the stream, then close it — and the close is what
      // finally rejects the `next()` we already walked away from.
      let rejectStep!: (err: Error) => void;
      const step = new Promise<string>((_, reject) => {
        rejectStep = reject;
      });
      const watch = new StallWatch('fixer', 10);
      await expect(watch.next(step)).rejects.toBeInstanceOf(StreamStalledError);
      rejectStep(new Error('closed by close()'));
      await new Promise((r) => setTimeout(r, 50));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});

describe('isConnectionRetry', () => {
  it('matches the frame a dropped connection actually produces', () => {
    expect(isConnectionRetry(CONNECTION_RETRY)).toBe(true);
  });

  it('rejects retries that carry an HTTP status, and anything that is not a retry', () => {
    expect(isConnectionRetry({ ...CONNECTION_RETRY, error_status: 429 })).toBe(false);
    expect(isConnectionRetry({ ...CONNECTION_RETRY, error_status: 529 })).toBe(false);
    expect(isConnectionRetry({ type: 'system', subtype: 'init' })).toBe(false);
    expect(isConnectionRetry({ type: 'assistant' })).toBe(false);
    expect(isConnectionRetry(null)).toBe(false);
    expect(isConnectionRetry(undefined)).toBe(false);
  });
});

describe('error messages', () => {
  it('names the role and the budget for a stall', () => {
    const err = new StreamStalledError('fixer', STALL_TIMEOUT_MS);
    expect(err.message).toBe('agent fixer produced no stream output for 15m — stream stalled');
    expect(err.name).toBe('StreamStalledError');
  });

  it('reports sub-minute budgets in seconds rather than rounding to 0m', () => {
    expect(new StreamStalledError('selftest', 3_000).message).toContain('for 3s');
  });

  it('says what to blame when the API is unreachable', () => {
    const err = new EnvironmentUnavailableError('auditor-compatibility', ENVIRONMENT_TIMEOUT_MS, 6);
    expect(err.message).toBe(
      'agent auditor-compatibility got 6 connection retries and no response in 5m — ' +
        'the API is unreachable (machine asleep, or no network)',
    );
    expect(err.name).toBe('EnvironmentUnavailableError');
  });

  it('keeps the count readable when there was only one retry', () => {
    expect(new EnvironmentUnavailableError('judge', 5_000, 1).message).toContain('1 connection retry');
  });
});
