export type BridgeErrorCategory =
  | 'transient'
  | 'permanent'
  | 'ambiguous'
  | 'auth'
  | 'validation'
  | 'routing';

export class BridgeError extends Error {
  public readonly category: BridgeErrorCategory;
  public readonly code: string;

  constructor(
    message: string,
    category: BridgeErrorCategory,
    code: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = 'BridgeError';
    this.category = category;
    this.code = code;
  }
}

export class TransientDeliveryError extends BridgeError {
  constructor(message: string, code = 'TRANSIENT_ERROR', options?: ErrorOptions) {
    super(message, 'transient', code, options);
    this.name = 'TransientDeliveryError';
  }
}

export class PermanentDeliveryError extends BridgeError {
  constructor(message: string, code = 'PERMANENT_ERROR', options?: ErrorOptions) {
    super(message, 'permanent', code, options);
    this.name = 'PermanentDeliveryError';
  }
}

export class AmbiguousDeliveryError extends BridgeError {
  constructor(message: string, code = 'AMBIGUOUS_OUTCOME', options?: ErrorOptions) {
    super(message, 'ambiguous', code, options);
    this.name = 'AmbiguousDeliveryError';
  }
}

export class AuthDeliveryError extends BridgeError {
  constructor(message: string, code = 'AUTH_FAILURE', options?: ErrorOptions) {
    super(message, 'auth', code, options);
    this.name = 'AuthDeliveryError';
  }
}
