import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { calculateBackoffMs } from '../../src/domain/backoff.js';

describe('Bounded Exponential Backoff with Jitter', () => {
  it('increases delay exponentially and respects maxBackoffMs ceiling', () => {
    const attempt1 = calculateBackoffMs({
      attempt: 1,
      baseBackoffMs: 1000,
      maxBackoffMs: 10000,
      randomFn: () => 1, // max jitter factor (1.0)
    });
    assert.equal(attempt1, 1000);

    const attempt3 = calculateBackoffMs({
      attempt: 3,
      baseBackoffMs: 1000,
      maxBackoffMs: 10000,
      randomFn: () => 1,
    });
    assert.equal(attempt3, 4000);

    const attempt10 = calculateBackoffMs({
      attempt: 10,
      baseBackoffMs: 1000,
      maxBackoffMs: 10000,
      randomFn: () => 1,
    });
    assert.equal(attempt10, 10000);
  });

  it('applies jitter between 50% and 100% of the exponential cap', () => {
    const minJitter = calculateBackoffMs({
      attempt: 2,
      baseBackoffMs: 1000,
      maxBackoffMs: 60000,
      randomFn: () => 0,
    });
    assert.equal(minJitter, 1000); // 0.5 * 2000

    const midJitter = calculateBackoffMs({
      attempt: 2,
      baseBackoffMs: 1000,
      maxBackoffMs: 60000,
      randomFn: () => 0.5,
    });
    assert.equal(midJitter, 1500); // 0.75 * 2000
  });
});
