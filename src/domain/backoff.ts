export interface BackoffOptions {
  attempt: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
  randomFn?: () => number;
}

/**
 * Calculates bounded exponential backoff with equal jitter:
 * ceiling = min(maxBackoffMs, baseBackoffMs * 2^(attempt - 1))
 * delay = ceiling * (0.5 + 0.5 * random())
 */
export function calculateBackoffMs(options: BackoffOptions): number {
  const { attempt, baseBackoffMs, maxBackoffMs, randomFn = Math.random } = options;
  const normalizedAttempt = Math.max(1, Math.floor(attempt));
  const exponential = baseBackoffMs * Math.pow(2, normalizedAttempt - 1);
  const capped = Math.min(maxBackoffMs, exponential);
  const jitterFactor = 0.5 + 0.5 * Math.min(1, Math.max(0, randomFn()));
  return Math.max(1, Math.round(capped * jitterFactor));
}
