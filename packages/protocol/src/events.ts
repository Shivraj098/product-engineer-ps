import { z } from 'zod';

export const FAILURE_CODES = ['GENERATOR_ERROR', 'SERVER_RESTARTED'] as const;
export const failureCodeSchema = z.enum(FAILURE_CODES);
export type FailureCode = z.infer<typeof failureCodeSchema>;

// Position of an event within its run: a gapless integer starting at 1. 
const seqSchema = z.number().int().min(1);

export const deltaEventSchema = z.object({
  seq: seqSchema,
  type: z.literal('delta'),
  text: z.string().min(1),
});

export const completedEventSchema = z.object({
  seq: seqSchema,
  type: z.literal('completed'),
});

export const failedEventSchema = z.object({
  seq: seqSchema,
  type: z.literal('failed'),
  code: failureCodeSchema,
  message: z.string().min(1),
});

export const runEventSchema = z.discriminatedUnion('type', [
  deltaEventSchema,
  completedEventSchema,
  failedEventSchema,
]);

export type DeltaEvent = z.infer<typeof deltaEventSchema>;
export type CompletedEvent = z.infer<typeof completedEventSchema>;
export type FailedEvent = z.infer<typeof failedEventSchema>;
export type RunEvent = z.infer<typeof runEventSchema>;
export type TerminalRunEvent = CompletedEvent | FailedEvent;

// A terminal event is the last event of a run,  nothing should follow it. 

export function isTerminalEvent(event: RunEvent): event is TerminalRunEvent {
  return event.type !== 'delta';
}