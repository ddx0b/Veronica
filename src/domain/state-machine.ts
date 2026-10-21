import { BridgeError } from './errors.js';
import type { DeliveryJobStatus } from './types.js';

const ALLOWED_TRANSITIONS: Readonly<Record<DeliveryJobStatus, ReadonlySet<DeliveryJobStatus>>> = {
  pending: new Set<DeliveryJobStatus>(['processing', 'dead_letter']),
  processing: new Set<DeliveryJobStatus>([
    'pending',
    'submitted',
    'delivered',
    'failed',
    'dead_letter',
    'unknown',
  ]),
  submitted: new Set<DeliveryJobStatus>([
    'submitted',
    'delivered',
    'failed',
    'dead_letter',
    'unknown',
  ]),
  delivered: new Set<DeliveryJobStatus>(['delivered']),
  failed: new Set<DeliveryJobStatus>(['processing', 'dead_letter']),
  dead_letter: new Set<DeliveryJobStatus>(['dead_letter']),
  unknown: new Set<DeliveryJobStatus>(['delivered', 'dead_letter', 'unknown']),
};

export function canTransitionStatus(
  from: DeliveryJobStatus,
  to: DeliveryJobStatus
): boolean {
  const allowed = ALLOWED_TRANSITIONS[from];
  return allowed ? allowed.has(to) : false;
}

export function assertValidStatusTransition(
  from: DeliveryJobStatus,
  to: DeliveryJobStatus
): void {
  if (!canTransitionStatus(from, to)) {
    throw new BridgeError(
      `Invalid delivery job state transition from '${from}' to '${to}'`,
      'validation',
      'INVALID_STATE_TRANSITION'
    );
  }
}
