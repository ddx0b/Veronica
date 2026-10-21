import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  canTransitionStatus,
  assertValidStatusTransition,
} from '../../src/domain/state-machine.js';
import { BridgeError } from '../../src/domain/errors.js';

describe('Delivery State Machine', () => {
  it('permits valid lifecycle transitions', () => {
    assert.equal(canTransitionStatus('pending', 'processing'), true);
    assert.equal(canTransitionStatus('processing', 'submitted'), true);
    assert.equal(canTransitionStatus('processing', 'failed'), true);
    assert.equal(canTransitionStatus('processing', 'dead_letter'), true);
    assert.equal(canTransitionStatus('processing', 'unknown'), true);
    assert.equal(canTransitionStatus('failed', 'processing'), true);
    assert.equal(canTransitionStatus('submitted', 'delivered'), true);
    assert.equal(canTransitionStatus('submitted', 'dead_letter'), true);
    assert.equal(canTransitionStatus('unknown', 'delivered'), true);
    assert.equal(canTransitionStatus('unknown', 'dead_letter'), true);
  });

  it('rejects invalid state transitions', () => {
    assert.equal(canTransitionStatus('pending', 'delivered'), false);
    assert.equal(canTransitionStatus('delivered', 'pending'), false);
    assert.equal(canTransitionStatus('dead_letter', 'processing'), false);
    assert.equal(canTransitionStatus('unknown', 'processing'), false);

    assert.throws(
      () => assertValidStatusTransition('unknown', 'processing'),
      (err: unknown) =>
        err instanceof BridgeError && err.code === 'INVALID_STATE_TRANSITION'
    );
  });
});
