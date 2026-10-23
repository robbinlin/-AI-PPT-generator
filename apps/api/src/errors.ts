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
    super(`尚未支援這項功能（${what}）`);
    this.name = "NotImplementedJobError";
  }
}

/**
 * Human-readable reason for a failed provider call. Vendors wrap the useful text in different
 * envelopes (ElevenLabs `{detail:{status,message}}`, Google `{error:{message}}`); surface that
 * text with the HTTP status so the user sees "401 invalid api key" instead of "internal error".
 */
export function providerErrorMessage(err: unknown): string {
  const e = err as { name?: string; status?: number; body?: string; message?: string };
  if (e?.name === "HttpError" && typeof e.status === "number") {
    let detail = (e.body ?? "").slice(0, 300);
    try {
      const parsed = JSON.parse(e.body ?? "") as { detail?: unknown; error?: unknown; message?: unknown };
      const d = parsed.detail ?? parsed.error ?? parsed.message;
      if (typeof d === "string") detail = d;
      else if (d && typeof d === "object") {
        const o = d as { message?: unknown; status?: unknown };
        detail = [typeof o.status === "string" ? o.status : "", typeof o.message === "string" ? o.message : ""].filter(Boolean).join(": ");
      }
    } catch {
      /* not JSON */
    }
    return `HTTP ${e.status}${detail ? ` ${detail}` : ""}`;
  }
  return e?.message || String(err);
}

/** Upstream vendor rejected or failed the request; the message carries the vendor's reason. */
export const upstream = (providerId: string, err: unknown) =>
  new ApiHttpError(502, "upstream", `${providerId}: ${providerErrorMessage(err)}`);
