/** Thrown by routes/services; the Fastify error handler maps it to an `ApiError` body. */
export class ApiHttpError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiHttpError";
  }
}

export const notFound = (what: string, id?: string) =>
  new ApiHttpError(404, "not_found", id ? `${what} ${id} not found` : `${what} not found`);

export const badRequest = (message: string, details?: unknown) =>
  new ApiHttpError(400, "bad_request", message, details);

export const conflict = (message: string) => new ApiHttpError(409, "conflict", message);

export const notImplemented = (message: string) => new ApiHttpError(501, "not_implemented", message);

/** Job handlers throw this to stop retries (bad input, provider rejected the request, etc.). */
export class NonRetryableJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NonRetryableJobError";
  }
}

/** Marker for job handlers whose integration is pending. Never retried. */
export class NotImplementedJobError extends NonRetryableJobError {
  constructor(what: string) {
    super(`${what} is not implemented yet`);
    this.name = "NotImplementedJobError";
  }
}
