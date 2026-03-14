const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
type LogLevel = keyof typeof LOG_LEVELS;

const currentLevel: LogLevel = (process.env.LOG_LEVEL as LogLevel) || "info";

function log(level: LogLevel, message: string, data?: unknown) {
  if (LOG_LEVELS[level] < LOG_LEVELS[currentLevel]) return;
  const entry = { timestamp: new Date().toISOString(), level, message, ...(data ? { data } : {}) };
  process.stderr.write(JSON.stringify(entry) + "\n");
}

export const logger = {
  debug: (msg: string, data?: unknown) => log("debug", msg, data),
  info: (msg: string, data?: unknown) => log("info", msg, data),
  warn: (msg: string, data?: unknown) => log("warn", msg, data),
  error: (msg: string, data?: unknown) => log("error", msg, data),
};
