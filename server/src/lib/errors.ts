/**
 * An error that is safe to show to the user. Anything else that is thrown becomes
 * a generic 500 so internal details (SQL, stack traces) never reach the browser.
 */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const notFound = (message: string) => new AppError(404, 'NOT_FOUND', message);
