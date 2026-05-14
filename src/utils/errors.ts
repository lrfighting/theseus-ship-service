export class AppError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(opts: {
    code: string;
    message: string;
    status?: number;
    retryable?: boolean;
    details?: Record<string, unknown>;
  }) {
    super(opts.message);
    this.code = opts.code;
    this.status = opts.status ?? 500;
    this.retryable = opts.retryable ?? false;
    this.details = opts.details;
  }

  toPayload() {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      details: this.details,
    };
  }
}

export function notFound(resource: string) {
  return new AppError({
    code: 'NOT_FOUND',
    message: `${resource} not found`,
    status: 404,
  });
}

export function badRequest(message: string, details?: Record<string, unknown>) {
  return new AppError({
    code: 'BAD_REQUEST',
    message,
    status: 400,
    details,
  });
}

export function aiTimeout(message = 'AI generation timed out') {
  return new AppError({
    code: 'AI_TIMEOUT',
    message,
    status: 504,
    retryable: true,
  });
}

export function aiUpstream(message: string, details?: Record<string, unknown>) {
  return new AppError({
    code: 'AI_UPSTREAM_ERROR',
    message,
    status: 502,
    retryable: true,
    details,
  });
}
