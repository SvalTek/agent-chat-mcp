export interface LogEntry {
  timestamp: string;
  level: "debug" | "info" | "warn" | "error";
  source: string;
  message: string;
}

const MAX_LOGS = 500;
const logs: LogEntry[] = [];

export function recordLog(
  level: LogEntry["level"],
  source: string,
  message: string,
) {
  logs.push({ timestamp: new Date().toISOString(), level, source, message });
  if (logs.length > MAX_LOGS) logs.splice(0, logs.length - MAX_LOGS);
}

export function getLogs(
  options: { limit?: number; level?: LogEntry["level"] } = {},
) {
  const limit = Math.min(Math.max(options.limit ?? 100, 1), MAX_LOGS);
  return logs.filter((entry) => !options.level || entry.level === options.level)
    .slice(-limit);
}

export function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export async function captureToolError<T>(
  name: string,
  operation: () => Promise<T> | T,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    recordLog("error", `tool:${name}`, errorText(error));
    throw error;
  }
}
