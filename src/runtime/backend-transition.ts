import type { AppEventBus } from '../backend/app-event-bus';
import type { BackendContext } from '../types';

/**
 * Atomically invalidate one backend runtime before replacement or shutdown.
 *
 * Callers perform transport teardown asynchronously after this boundary. New
 * requests are rejected immediately, while in-flight handlers are woken by
 * the generation-scoped event.
 */
export function beginBackendRuntimeTransition(
  ctx: BackendContext,
  bus: AppEventBus,
): number {
  const runtimeGeneration = ++ctx.runtimeGeneration;
  ctx.acceptingRequests = false;
  bus.emit('backend-runtime-changing', {
    backendId: ctx.id,
    runtimeGeneration,
    instanceKey: ctx.instanceKey,
  });
  return runtimeGeneration;
}
