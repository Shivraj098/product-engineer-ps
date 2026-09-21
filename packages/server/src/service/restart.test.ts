import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRuntime } from '../container';
import { ManualGenerator } from '../generators/ManualGenerator';
import { silentLogger } from '../logger';
import { RESTART_FAILURE_MESSAGE } from '../store/SqliteRunStore';
import { collect, seqsOf, textOf } from '../testing/helpers';

/**
 * A "restart" here means: the first runtime is closed without finishing anything (like a
 * killed process: its generator and connections simply vanish), and a brand new runtime is
 * built over the same database file, exactly as a fresh process would do at startup.
 */
describe('AC4: service restart', () => {
  let directory: string;
  let dbPath: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'tether-restart-'));
    dbPath = join(directory, 'tether.db');
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it('recovers durable state instead of starting an unrelated run', async () => {
    const generator = new ManualGenerator();
    const before = createRuntime({ dbPath, generator, logger: silentLogger });
    const { conversationId } = before.service.createConversation();
    const sent = before.service.sendMessage(conversationId, { messageId: 'm1', content: 'hello' });
    const runId = sent.response.run.id;

    await generator.emit('a ');
    await generator.emit('b ');
    await generator.emit('c ');
    before.close(); // The process dies mid-reply: no terminal event was ever written.

    const after = createRuntime({ dbPath, generator: new ManualGenerator(), logger: silentLogger });
    try {
      expect(after.recoveredRunIds).toEqual([runId]);

      // A client that had applied event 1 reconnects and gets the rest of the durable history,
      // then an explicit terminal failure.
      const events = await collect(
        after.service.openEventStream(runId, 1, new AbortController().signal),
      );
      expect(seqsOf(events)).toEqual([2, 3, 4]);
      expect(events.at(-1)).toEqual({
        seq: 4,
        type: 'failed',
        code: 'SERVER_RESTARTED',
        message: RESTART_FAILURE_MESSAGE,
      });

      const snapshot = after.service.getRunSnapshot(runId);
      expect(snapshot).toMatchObject({ state: 'failed', text: 'a b c ', lastSeq: 4 });

      // Retrying the same message finds the same run; it does not start a new one.
      const retry = after.service.sendMessage(conversationId, {
        messageId: 'm1',
        content: 'hello',
      });
      expect(retry.created).toBe(false);
      expect(retry.response.run.id).toBe(runId);

      // The conversation is usable again with a genuinely new message.
      const next = after.service.sendMessage(conversationId, { messageId: 'm2', content: 'again' });
      expect(next.created).toBe(true);
      expect(next.response.run.id).not.toBe(runId);
    } finally {
      after.close();
    }
  });

  it('replays a run that completed before the restart, unchanged', async () => {
    const generator = new ManualGenerator();
    const before = createRuntime({ dbPath, generator, logger: silentLogger });
    const { conversationId } = before.service.createConversation();
    const { response } = before.service.sendMessage(conversationId, {
      messageId: 'm1',
      content: 'hello',
    });
    await generator.emit('done ');
    generator.finish();
    await before.executor.idle();
    const original = await collect(
      before.service.openEventStream(response.run.id, 0, new AbortController().signal),
    );
    before.close();

    const after = createRuntime({ dbPath, generator: new ManualGenerator(), logger: silentLogger });
    try {
      expect(after.recoveredRunIds).toEqual([]);
      const replayed = await collect(
        after.service.openEventStream(response.run.id, 0, new AbortController().signal),
      );
      expect(replayed).toEqual(original);
      expect(textOf(replayed)).toBe('done ');
    } finally {
      after.close();
    }
  });
});
