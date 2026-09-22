# Product Engineering Challenge Submission

## Candidate

- **Name: Shivraj Singh**
- **Email: rajshivraj5555@gmail.com**
- **GitHub: https://github.com/Shivraj098**
- **Selected problem: Problem 1: Resumable Realtime Conversation**
- **Demo video: https://docs.google.com/document/d/1ehe7lIMXFKnMQMkpClIVZrOh_hKWf-1VmYhH7JeYQFM/edit?usp=sharing**

## Run the project

Prerequisites: Node.js 22.13+ and npm 10+. No database server, no API key, and no paid
service of any kind is required — SQLite is a local file and the reply generator is a
deterministic fake.

```text
git clone <https://github.com/Shivraj098/product-engineer-ps>
cd <https://github.com/Shivraj098/product-engineer-ps>
npm install
npm run dev
```

This starts the API server on `http://localhost:3001` and the web app on
`http://localhost:5173` together (via `concurrently`). Open `http://localhost:5173`.

Optional environment variables (all have working defaults; see `.env.example`; **none
are secrets**, so nothing here needs to be kept out of the repo): `PORT`, `DB_PATH`,
`TOKEN_DELAY_MS`, `HEARTBEAT_MS`, `REPLAY_WINDOW`, `DEMO_MODE`. A `.env` in the repo
root is picked up automatically if you create one (Node's `--env-file-if-exists`); it
is entirely optional.

**Successful scenario:** type a message and press Send (or Enter). The reply streams
in and the connection badge shows Connecting → Connected → Completed.

**Failure/recovery scenario:** open the collapsible "dev panel" below the composer.
- Click "Fail midway" to fill the box with a prompt that fails partway through
  generation, then Send — the run ends as Failed with the partial text kept and the
  reason shown.
- Or click "Long reply" then Send, and while it streams click "Drop server
  connections" — the badge shows Reconnecting, then Connected again, with no gap or
  repeated text once it finishes.
- Or start a long reply, stop the server process (Ctrl+C) while it's mid-reply, and
  restart it (`npm run dev`) — reloading the page shows the run as Failed with reason
  `SERVER_RESTARTED` and the partial text intact.



## Run the tests

```text
npm test # all packages: 241 tests
npm run typecheck
npm run lint
npm run format:check
```
Tests are deterministic: no real sleeps, no network, no paid service. The server uses
an injectable clock/id generator and a step-by-step "manual" fake generator; the client
uses a scripted fake transport; the restart test uses a real temp SQLite file and a
freshly constructed runtime, exactly as a new process would see it.

## Acceptance scenarios and verification

All six of the brief's acceptance scenarios are implemented and covered by automated
tests, at both the domain layer and over real HTTP:

- **AC1 (ordered live stream):** `packages/server/src/service/ConversationService.test.ts`,
  `packages/server/src/http/sse.test.ts`
- **AC2 (missed-event recovery):** same files, plus `packages/client-core/src/RunStream.test.ts`
- **AC3 (replay/live overlap):** `packages/server/src/runtime/tail.test.ts` ("keeps replay
  and live delivery in one gapless, duplicate-free sequence") — replay and live delivery
  share one code path by construction, so overlap cannot occur; the test forces the
  interleaving anyway.
- **AC4 (service restart):** `packages/server/src/service/restart.test.ts`, using a real
  temp-file database and a brand-new runtime, matching what a fresh process would do.
- **AC5 (generation failure):** `packages/server/src/runtime/RunExecutor.test.ts` and the
  service test — a failed run can never later become completed (enforced by a state
  machine, a database constraint, and a test of both).
- **AC6 (unknown/stale cursor):** `packages/server/src/domain/cursor.test.ts`, the service
  and HTTP tests, and `RunStream.test.ts`'s resync test — a stale cursor gets a `410`
  with a `recovery` hint, and the client automatically fetches the run snapshot and
  resumes from there.

Provide the exact command or steps used to run the problem-specific verification benchmark:

```text
Run:
npm run benchmark
```
This generates 40 ordered events for one run, severs the client's connection from the
server side partway through (the same mechanism the HTTP tests use), and lets the real
client's own reconnect logic (bounded, jittered backoff) recover on its own, then checks
the reconstructed reply for missing/duplicate events.

Observed result (representative run; exact numbers are stable across runs because the
scenario is deterministic):

{
"eventCount": 41,
"missing": [],
"duplicates": 0,
"reconnects": 1,
"finalState": "completed",
"textMatches": true,
"ok": true
}
OK: 41 events, 0 missing, 0 duplicates, 1 reconnect(s), final state = completed.

I also deliberately broke the client's deduplication logic and made the server resend
one already-delivered event on every reconnect, to confirm the benchmark actually
catches a violation rather than passing regardless. With both changes in place the
benchmark correctly failed (client rejected the resent event as "not the next expected
one," kept reconnecting to the same broken cursor, exhausted its retry budget, and was
left at `running` with dozens of events missing). Both changes were then reverted and
confirmed byte-identical to the originals before committing.

**Failure/recovery scenario demonstrated in the video:** 
- Demonstrated an active streamed response recovering after the server connection was intentionally dropped, with the client reconnecting from its last processed cursor without duplicate or missing content.
- Also demonstrated browser reload persistence, server restart handling with SERVER_RESTARTED, and generator failure while preserving partial output.

## Architecture and data flow

Four packages, dependencies pointing one way (`web -> client-core -> protocol`,
`server -> protocol`):

- **`protocol`** — the shared contract: event and error types, a run state machine
  (`running -> completed | failed`, terminal states have no outgoing transitions), zod
  schemas for everything that crosses a trust boundary.
- **`server`** — `SqliteRunStore` is the only code that reads or writes run history and
  the sole owner of event ordering (`seq = last_seq + 1`, assigned inside a transaction).
  `RunExecutor` drives the reply generator and persists each chunk before announcing it.
  `tailRun` is a single read loop that serves both replay and "live" delivery — a
  connection is just a cursor walking the append-only event log, so overlap between
  replay and live events is impossible by construction, not by a special case.
  `ConversationService` holds the application rules (idempotent send, cursor
  validation) with no knowledge of HTTP. The HTTP layer (`routes.ts`, `sse.ts`) only
  translates: validate input, call one service method, stream the result.
- **`client-core`** — framework-free, so it's unit-testable without a browser: an
  incremental SSE parser, a reducer that only applies an event if it is exactly the
  next expected one (older = duplicate, ignored; newer = gap, triggers a reconnect),
  and `RunStream`, which owns the reconnect loop (bounded exponential backoff with full
  jitter) and resyncs from a server snapshot when a cursor can no longer be replayed.
- **`web`** — a thin React layer over `client-core`. `App.tsx` owns all state; every
  other component is presentational.

Data flow for one reply: browser POSTs a message -> server starts a run and returns
immediately -> browser opens `GET /runs/:id/events?after=<cursor>` -> server streams
persisted+live events in one ordered sequence -> client reducer applies them
idempotently -> on disconnect, the client reconnects with its own last-applied
position as the cursor, and the server resumes exactly there.

## Technology choices

TypeScript everywhere (client and server share the wire contract as compiled types, not
duplicated ad hoc). Express + SQLite (`better-sqlite3`) on the server: SQLite needs zero
setup for a 10-minute reviewer path, and its synchronous API makes "append an event and
assign its position" atomic with no interleaving to reason about — a real concern here,
since ordering correctness is the whole point of the exercise. SSE over WebSockets: the
server only needs to push (client actions are plain POSTs), and the resume cursor is
just an ordinary query parameter on a GET, so no custom resume handshake had to be
invented. React + Vite on the client, kept as thin as possible; all the reconnect and
ordering logic lives in a framework-free package precisely so it's testable without a
browser. The trade-off accepted everywhere: a single-process, in-memory-notifier design
that does not scale past one server — documented explicitly below rather than solved.

## Important decisions

1. **Replay and live delivery are the same code path.** A connection is a cursor
   reading forward through the durable event log; when it catches up it waits for a
   notification and reads again. There is no separate "live" channel to keep in sync
   with the durable one, so AC3 (no duplicate logical events across replay/live) holds
   by construction rather than by careful special-casing.
2. **A run is never resumed after a restart; it's explicitly failed.** On startup,
   any run still marked `running` becomes `failed` with a `SERVER_RESTARTED` reason and
   a terminal event is appended, so a reconnecting client sees an honest outcome instead
   of a run silently pretending to still be in progress. I chose this because a real
   model stream cannot resume mid-token, and faking resumability with the deterministic
   generator would demonstrate something production couldn't actually do.
3. **Deduplication happens on the client, not just the server.** The server never
   sends an event at or before a client's cursor, but the client's reducer independently
   verifies this and drops anything that isn't exactly the next expected position. This
   is defense-in-depth: I proved its value by temporarily breaking both the server's
   "don't resend" behaviour and the client's check together, and watched the verification
   benchmark correctly fail.

## Assumptions and limitations

- One process, one SQLite file: correct and simple, but does not scale to multiple
  server instances (the in-process notifier and single-writer database are both
  single-server assumptions).
- The reply generator is a deterministic fake (`buildReplyChunks`, seeded by the prompt
  text), steerable via `/chunks:N` and `/fail-after:N` directives in the message itself.
  A real model provider was intentionally out of scope, per the brief.
- Snapshots (`GET /runs/:id`) re-read and re-assemble every delta for that run; fine at
  the row counts here, but would need a materialized snapshot at real volume.
- The "replay window" (how many recent events a client may resume from) is enforced at
  read time while every event is still kept on disk; production would actually compact.
- No authentication, no rate limiting, no connection caps — all explicitly out of scope
  per the brief, and the codebase is unauthenticated by design.
- Cancellation (client-initiated) was not built; the brief lists it as an optional
  stretch item, and the required behaviour (AC1–AC6) took priority.

## Production and scale

What the submission does now: a single Node process owns one SQLite file, an in-memory
map of "who's waiting on which run" (`RunNotifier`), and an in-memory registry of open
HTTP connections. All of that is process-local.

What I would change first, and why: move the event log itself to something a second
server instance can also read and write consistently (Postgres, or a log-native store
like Redis Streams), and replace the in-process notifier with a cross-process signal
(Postgres `LISTEN`/`NOTIFY`, or the same Redis Streams). The cursor-based resume
protocol itself would not need to change — a client's `after=N` request means exactly
the same thing whichever server instance answers it, as long as they all read from the
same durable log. I'd also add a materialized "completed" snapshot per run (rather than
reassembling from deltas every time) and a real retention/compaction policy instead of
keeping every event indefinitely.

## AI usage

I used Claude and Chatgpt for this project ,for analyzing the five
problem briefs and picking one, for architecture and API design, and for imporving the
implementation and its tests across all four packages, manually implementing and then checking the test generated, mainly to achieve the desired outcome

## Credibility note

Describe one product or system you previously helped ship:

- Product: TaskFlow - a team task and project management platform.
- Problem solved: Built to help teams manage projects, assign tasks, track progress, and keep team members synchronized in real time instead of relying on fragmented communication.
- My contribution: I worked across the full stack with designing the database with PostgreSQL, building APIs and application logic with Next.js and TypeScript, implementing authentication and role-based access, and adding real-time task updates.
- Scale / operational complexity: The system was designed as a multi-user application with team/project-level permissions and concurrent updates, requiring consistent authorization and reliable synchronization between users.
- Difficult engineering decision: One of the harder decisions was handling real-time updates without making the database the source of every UI refresh. I introduced event-driven updates so clients could reflect task changes immediately while keeping the database as the source of truth.
- Evidence: Public repository and deployed application are available on my GitHub: `https://github.com/Shivraj098`


