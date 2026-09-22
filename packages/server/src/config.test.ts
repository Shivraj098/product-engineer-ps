import { describe, expect, it } from 'vitest';
import { loadConfig } from './config';

describe('loadConfig', () => {
  it('has working defaults for local development', () => {
    expect(loadConfig({})).toEqual({
      port: 3001,
      dbPath: './data/tether.db',
      tokenDelayMs: 120,
      heartbeatMs: 15_000,
      replayWindow: 0,
      demoMode: true,
    });
  });

  it('reads overrides from the environment', () => {
    const config = loadConfig({
      PORT: '4000',
      DB_PATH: '/tmp/x.db',
      TOKEN_DELAY_MS: '5',
      HEARTBEAT_MS: '0',
      REPLAY_WINDOW: '50',
      DEMO_MODE: 'false',
    });
    expect(config).toEqual({
      port: 4000,
      dbPath: '/tmp/x.db',
      tokenDelayMs: 5,
      heartbeatMs: 0,
      replayWindow: 50,
      demoMode: false,
    });
  });

  it('turns demo mode off in production unless explicitly enabled', () => {
    expect(loadConfig({ NODE_ENV: 'production' }).demoMode).toBe(false);
    expect(loadConfig({ NODE_ENV: 'production', DEMO_MODE: 'true' }).demoMode).toBe(true);
  });

  it.each([
    ['a non-numeric port', { PORT: 'abc' }, 'PORT'],
    ['a port out of range', { PORT: '70000' }, 'PORT'],
    ['a negative replay window', { REPLAY_WINDOW: '-1' }, 'REPLAY_WINDOW'],
    ['a malformed boolean', { DEMO_MODE: 'yes' }, 'DEMO_MODE'],
  ])('fails fast on %s, naming the variable', (_label, env, variable) => {
    expect(() => loadConfig(env)).toThrow(new RegExp(`Invalid configuration:.*${variable}`));
  });
});
