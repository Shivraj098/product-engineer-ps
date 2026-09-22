/**
 * Verification benchmark for Problem 1 (Resumable Realtime Conversation).
 *
 * Generates 40 ordered events for one run, interrupts the client's connection at least
 * once while generation is still active (by severing the socket server-side, the same
 * mechanism used in the HTTP tests), and lets the real client (RunStream) detect the
 * drop and reconnect on its own. It then checks the reconstructed response for zero
 * missing and zero duplicate events. Both the real server and the real client run
 * in-process; no browser and no paid model is involved, so this is fully repeatable.
 *
 * Run this test with:  npm run benchmark
 */
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import {
  ManualGenerator,
  buildReplyChunks,
  createApp,
  createRuntime,
  silentLogger,
} from '@tether/server';
import { ApiClient, RunStream, type RunStreamState } from '@tether/client-core';

const CHUNK_COUNT = 40;
const INTERRUPT_AFTER_EVENT = 12; // client is disconnected well before completion
const PROMPT = `Resumable stream benchmark /chunks:${CHUNK_COUNT}`;
// A snappier backoff than the product default (500ms-8s), so the benchmark finishes in
// about a second instead of several. Its shape (exponential, jittered, bounded) is unchanged.
const BENCHMARK_BACKOFF = { baseMs: 20, capMs: 100, maxAttempts: 8 };

interface Report {
  eventCount: number;
  missing: number[];
  duplicates: number;
  reconnects: number;
  finalState: string;
  textMatches: boolean;
  ok: boolean;
}

function fail(report: Report, message: string): never {
  console.error(`FAIL: ${message}`);
  console.error(JSON.stringify(report, null, 2));
  process.exit(1);
}

async function main(): Promise<void> {
  const generator = new ManualGenerator();
  const runtime = createRuntime({ dbPath: ':memory:', generator, logger: silentLogger });
  const { app, connections } = createApp({
    service: runtime.service,
    logger: silentLogger,
    heartbeatMs: 0,
    demoMode: true,
  });
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const port = (server.address() as AddressInfo).port;
  const api = new ApiClient({ baseUrl: `http://127.0.0.1:${port}` });

  try {
    const { conversationId } = await api.createConversation();
    const { run } = await api.sendMessage(conversationId, {
      messageId: randomUUID(),
      content: PROMPT,
    });

    const seenSeqs: number[] = [];
    const stream = new RunStream({
      runId: run.id,
      api,
      backoff: BENCHMARK_BACKOFF,
      onEvent: (event, outcome) => {
        if (outcome === 'applied') {
          seenSeqs.push(event.seq);
        }
      },
    });

    // Feed the generator in the background, independently of the client's connection state,
    // so the run keeps producing events while the client is disconnected below. A small
    // per-chunk delay (mirroring the real demo generator's TOKEN_DELAY_MS) gives the
    // benchmark a real window in which to interrupt mid-generation, rather than a race
    // against the whole 40-chunk reply landing in a single burst of microtasks.
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const feeding = (async () => {
      for (const chunk of buildReplyChunks(PROMPT, CHUNK_COUNT)) {
        await generator.emit(chunk);
        await sleep(5);
      }
      generator.finish();
    })();

    stream.start();
    await stream.waitFor((state) => state.run.lastSeq >= INTERRUPT_AFTER_EVENT);

    // The interruption: sever the connection from the server side, exactly the way a
    // dropped network connection would look to the client. RunStream's own reconnect
    // logic (backoff + resume from its cursor) takes it from here, unassisted.
    const dropped = connections.dropAll();
    if (dropped !== 1) {
      throw new Error(`Expected exactly one open connection to drop, dropped ${dropped}.`);
    }

    const final: RunStreamState = await stream.waitFor(
      (state) => state.connection.status === 'closed' || state.connection.status === 'disconnected',
    );
    await feeding;

    const expectedSeqs = Array.from({ length: CHUNK_COUNT + 1 }, (_, index) => index + 1); // + completed
    const missing = expectedSeqs.filter((seq) => !seenSeqs.includes(seq));
    const duplicateCount = seenSeqs.length - new Set(seenSeqs).size;
    const expectedText = buildReplyChunks(PROMPT, CHUNK_COUNT).join('');

    const report: Report = {
      eventCount: seenSeqs.length,
      missing,
      duplicates: duplicateCount,
      reconnects: final.reconnects,
      finalState: final.run.status,
      textMatches: final.run.text === expectedText,
      ok:
        missing.length === 0 &&
        duplicateCount === 0 &&
        final.run.status === 'completed' &&
        final.run.text === expectedText &&
        final.reconnects >= 1,
    };

    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) {
      fail(report, 'One or more invariants were violated.');
    }
    console.log(
      `OK: ${report.eventCount} events, 0 missing, 0 duplicates, ${report.reconnects} reconnect(s), final state = ${report.finalState}.`,
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    runtime.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
