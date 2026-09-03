export interface SerializedException {
  message: string;
  code: string;
  correlationId?: string;
  stack?: string;
  cause?: string;
  metadata?: unknown;
}

/**
 * Base class for domain and application exceptions.
 * `metadata` carries technical context for debugging — never secrets.
 */
export abstract class ExceptionBase extends Error {
  abstract code: string;

  constructor(
    override readonly message: string,
    readonly correlationId?: string,
    override readonly cause?: Error,
    readonly metadata?: unknown
  ) {
    super(message);
    Error.captureStackTrace(this, this.constructor);
  }

  /**
   * Plain-object form for logs and cross-process transport.
   * Do not return stack traces to end users in production.
   */
  toJSON(): SerializedException {
    return {
      message: this.message,
      code: this.code,
      correlationId: this.correlationId,
      stack: this.stack,
      cause: this.cause ? JSON.stringify(this.cause) : undefined,
      metadata: this.metadata,
    };
  }
}
