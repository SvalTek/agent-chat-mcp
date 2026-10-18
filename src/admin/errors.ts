export class AdminError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 401 | 403 | 404 | 409 | 429 = 400,
  ) {
    super(message);
  }
}
export function required<T>(
  value: T | null | undefined,
  message = "Record not found.",
): T {
  if (value == null) throw new AdminError(message, 404);
  return value;
}
