/**
 * A periodic "still working" line for the long, quiet stretches of a review.
 *
 * An audit or a synthesis can run for an hour without logging anything, and from the outside that
 * looks exactly like a hung run. So while a review runs, a line goes out on an interval naming the
 * stage, how long it has been in it, and every agent or repo command still in flight — with how
 * long ago each agent last produced output, which is what tells a slow agent from a stalled one.
 */
export const HEARTBEAT_INTERVAL_MS = 2 * 60 * 1000;

interface Activity {
  label: string;
  startedAt: number;
  /** When it last produced output; null for work that never reports any (a buffered command). */
  lastOutputAt: number | null;
}

const activities = new Set<Activity>();
let stage: { name: string; since: number } | null = null;

export function markStage(name: string, now: number = Date.now()): void {
  stage = { name, since: now };
}

/** Names `label` in every heartbeat until `done()`. `output()` records that it is still talking. */
export function track(label: string, now: () => number = Date.now): { output(): void; done(): void } {
  const activity: Activity = { label, startedAt: now(), lastOutputAt: null };
  activities.add(activity);
  return {
    output: () => {
      activity.lastOutputAt = now();
    },
    done: () => {
      activities.delete(activity);
    },
  };
}

function elapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
}

/**
 * The line for this moment, or null when there is nothing worth saying: a local run waiting on the
 * owner's answers can sit idle for hours, and a line every two minutes would bury the log.
 */
export function heartbeatLine(now: number): string | null {
  if (stage?.name === 'awaiting_answers' && activities.size === 0) return null;
  const head = stage ? `still ${stage.name} (${elapsed(now - stage.since)} in this stage)` : 'still running';
  if (activities.size === 0) return `${head} — no agent or command running`;
  const running = [...activities].map((a) =>
    a.lastOutputAt === null
      ? `${a.label} ${elapsed(now - a.startedAt)}`
      : `${a.label} ${elapsed(now - a.startedAt)} (last output ${elapsed(now - a.lastOutputAt)} ago)`,
  );
  return `${head} — ${activities.size} running: ${running.join('; ')}`;
}

/** Starts the interval; the returned function stops it. Never keeps the process alive on its own. */
export function startHeartbeat(intervalMs: number = HEARTBEAT_INTERVAL_MS): () => void {
  const timer = setInterval(() => {
    const line = heartbeatLine(Date.now());
    if (line) console.log(line);
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

export function resetHeartbeatForTests(): void {
  activities.clear();
  stage = null;
}
