import { z } from 'zod';

const booleanFlag = z.enum(['true', 'false']).transform((value) => value === 'true');

const envSchema = z.object({
  PORT: z.coerce.number().int().min(0).max(65535).default(3001),
  DB_PATH: z.string().min(1).default('./data/tether.db'),
  TOKEN_DELAY_MS: z.coerce.number().int().min(0).default(120),
  HEARTBEAT_MS: z.coerce.number().int().min(0).default(15_000),
  REPLAY_WINDOW: z.coerce.number().int().min(0).default(0),
  DEMO_MODE: booleanFlag.optional(),
  NODE_ENV: z.string().optional(),
});

export interface Config {
  port: number;
  dbPath: string;
  /** Pause between chunks in the demo generator. */
  tokenDelayMs: number;
  /** SSE keep-alive interval. 0 disables heartbeats. */
  heartbeatMs: number;
  /** How many of a run's most recent events can be replayed. 0 means all of them. */
  replayWindow: number;
  /** Enables demo-only endpoints. On unless NODE_ENV is "production". */
  demoMode: boolean;
}

/** Reads and validates configuration from environment variables. Fails fast when invalid. */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid configuration: ${problems}`);
  }
  const values = parsed.data;
  return {
    port: values.PORT,
    dbPath: values.DB_PATH,
    tokenDelayMs: values.TOKEN_DELAY_MS,
    heartbeatMs: values.HEARTBEAT_MS,
    replayWindow: values.REPLAY_WINDOW,
    demoMode: values.DEMO_MODE ?? values.NODE_ENV !== 'production',
  };
}
