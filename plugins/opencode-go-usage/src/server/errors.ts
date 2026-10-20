export class AppError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "AppError";
    this.code = code;
  }
}

export function describeError(error: unknown): { code: string; message: string } {
  if (error instanceof AppError) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof Error) {
    return { code: "internal_error", message: error.message };
  }
  return { code: "internal_error", message: String(error) };
}

/** Remove anything that could look like a bearer token from text we return. */
export function scrub(text: string, secret?: string): string {
  let out = text;
  if (secret && secret.length >= 8) {
    out = out.split(secret).join("[redacted]");
  }
  return out.replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, "$1[redacted]");
}
