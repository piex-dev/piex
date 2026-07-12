export function isEnoent(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

export function toErrorMessage(value: unknown): string {
  if (value instanceof Error) return value.message;
  return String(value);
}
