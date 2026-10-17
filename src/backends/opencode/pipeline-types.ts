/**
 * Pipeline-internal types for the OpenCode backend.
 *
 * These are OpenCode-private (not shared across backends). They exist to
 * pipeline between the raw OpenCode SDK event shapes (nested, UPPER-case IDs)
 * and the flat SerializableToolState shape the SSP layer expects.
 *
 * @module
 */

import type { StreamToolState } from './sdk-events';

/**
 * Flat tool-state shape matching {@link SerializableToolState}
 * (src/ssp/types.ts) — the shape `ToolInvocationSSP` expects in its `state`
 * payload. Raw OpenCode `StreamToolState` nests `time.{start,end}`; the pipeline
 * flattens those via {@link flattenToolState} when building SSP payloads.
 */
export interface PipelineToolState {
  status: 'pending' | 'running' | 'completed' | 'error';
  input: Record<string, unknown>;
  output?: string;
  title?: string;
  error?: string;
  metadata?: Record<string, unknown>;
  startTime?: number;
  endTime?: number;
}

/**
 * Flatten a raw OpenCode `StreamToolState` (discriminated union, nested
 * `time.{start,end}`) into a flat {@link PipelineToolState}.
 *
 * The `pending` branch has only `input`; `running`/`completed`/`error` add
 * `title`/`output`/`error`/`metadata`/`time` as applicable. Time fields are
 * lifted to top-level `startTime`/`endTime`.
 */
export function flattenToolState(state: StreamToolState): PipelineToolState {
  switch (state.status) {
    case 'pending':
      return { status: 'pending', input: state.input };
    case 'running':
      return {
        status: 'running',
        input: state.input,
        title: state.title,
        metadata: state.metadata,
        startTime: state.time?.start,
      };
    case 'completed':
      return {
        status: 'completed',
        input: state.input,
        output: state.output,
        title: state.title,
        metadata: state.metadata,
        startTime: state.time?.start,
        endTime: state.time?.end,
      };
    case 'error':
      return {
        status: 'error',
        input: state.input,
        error: state.error,
        metadata: state.metadata,
        startTime: state.time?.start,
        endTime: state.time?.end,
      };
  }
}

/**
 * Safely read the `title` from a raw {@link StreamToolState}.
 *
 * Only the `running`/`completed` branches carry `title`; `pending`/`error`
 * do not. Use this instead of `state.title` to keep the discriminated union
 * happy without an `as` cast at every call site.
 */
export function getToolStateTitle(state: StreamToolState | undefined): string | undefined {
  if (!state) {return undefined;}
  return state.status === 'running' || state.status === 'completed' ? state.title : undefined;
}
