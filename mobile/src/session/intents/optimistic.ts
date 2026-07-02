import type { Action } from '@reduxjs/toolkit';
import type { AppThunk, RuntimeDeps } from '@/app/store';

/**
 * The ONE mutate-and-send path. Every user action that changes a session AND talks to the laptop
 * flows through here: dispatch the optimistic change now, run the network send, and on failure
 * dispatch the rollback so the UI never lies about a decision that never left the device.
 *
 * This single primitive replaces the three hand-rolled optimism/rollback shapes the old
 * god-object carried (approval, elicitation, mode) — and makes the missing one (interrupt) a
 * one-liner if/when we choose to clear busy optimistically.
 */
export interface OptimisticSpec<T> {
  /** Dispatched immediately, before the send. */
  apply?: Action | Action[];
  /** The network effect. Throw to trigger rollback. */
  send: (deps: RuntimeDeps) => Promise<T>;
  /** Dispatched if `send` throws, to undo `apply`. */
  rollback?: (err: unknown) => Action | Action[] | void;
}

function toArray(a: Action | Action[] | void): Action[] {
  if (!a) return [];
  return Array.isArray(a) ? a : [a];
}

export function optimistic<T = void>(spec: OptimisticSpec<T>): AppThunk<Promise<void>> {
  return async (dispatch, _getState, deps) => {
    for (const action of toArray(spec.apply)) dispatch(action);
    try {
      await spec.send(deps);
    } catch (err) {
      for (const action of toArray(spec.rollback?.(err))) dispatch(action);
    }
  };
}
