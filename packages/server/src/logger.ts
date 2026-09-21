export type LogFields = Record<string, unknown>;

export interface Logger {
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

export const silentLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/** One JSON object per line. Log ids and codes, never message content. */
export function createJsonLogger(write: (line: string) => void = console.log): Logger {
  const log = (level: string, message: string, fields: LogFields = {}): void => {
    write(JSON.stringify({ time: new Date().toISOString(), level, message, ...fields }));
  };
  return {
    info: (message, fields) => log('info', message, fields),
    warn: (message, fields) => log('warn', message, fields),
    error: (message, fields) => log('error', message, fields),
  };
}
