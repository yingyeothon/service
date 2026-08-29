export type ErrorCode =
  | "bad_request"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "gone"
  | "payload_too_large"
  | "rate_limited"
  /** 429 with its own code: a member already holds the maximum number of event drafts. */
  | "draft_limit"
  | "internal"
  | "unavailable";

const DEFAULT_STATUS: Record<ErrorCode, number> = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  gone: 410,
  payload_too_large: 413,
  rate_limited: 429,
  draft_limit: 429,
  internal: 500,
  unavailable: 503,
};

/** An error that maps directly to an HTTP status and a stable machine code. */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: unknown;

  constructor(
    code: ErrorCode,
    message?: string,
    options: { status?: number; details?: unknown; cause?: unknown } = {},
  ) {
    super(message ?? code, { cause: options.cause });
    this.name = "AppError";
    this.code = code;
    this.status = options.status ?? DEFAULT_STATUS[code];
    this.details = options.details;
  }
}

export function isAppError(e: unknown): e is AppError {
  return (
    e instanceof AppError ||
    (typeof e === "object" &&
      e !== null &&
      (e as { name?: string }).name === "AppError")
  );
}
