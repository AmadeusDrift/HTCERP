export class PublicError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly source = 'workbench',
    readonly retryable = false,
    readonly retryAfterSeconds?: number,
  ) {
    super(message)
  }
}
