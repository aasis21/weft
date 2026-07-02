import { configureStore, type Action, type ThunkAction } from '@reduxjs/toolkit';
import { sessionsReducer } from '@/session/sessionsSlice';
import { createTransportRegistry, type TransportRegistry } from '@/services/transport/registry';

/**
 * The impure dependencies the store's thunks/runtime are allowed to reach: the transport
 * registry (the ONLY owner of sockets) and an injectable clock (so timer-driven behaviour
 * stays deterministic under fake timers in tests). Passed as the thunk `extraArgument`.
 */
export interface RuntimeDeps {
  registry: TransportRegistry;
  clock: () => number;
}

export function makeStore(deps?: Partial<RuntimeDeps>) {
  const resolved: RuntimeDeps = {
    registry: deps?.registry ?? createTransportRegistry(),
    clock: deps?.clock ?? (() => Date.now()),
  };
  const store = configureStore({
    reducer: { sessions: sessionsReducer },
    middleware: (getDefault) =>
      // Envelopes carry non-serializable payloads (CryptoKey material, image blobs, arbitrary
      // tool args in the debug log), and timers live outside the store — so the serializable and
      // immutable dev checks are noise here. State purity is enforced by construction (Immer + no
      // I/O in reducers), not by the middleware.
      getDefault({ thunk: { extraArgument: resolved }, serializableCheck: false, immutableCheck: false }),
  });
  return Object.assign(store, { deps: resolved });
}

export type AppStore = ReturnType<typeof makeStore>;
export type RootState = ReturnType<AppStore['getState']>;
export type AppDispatch = AppStore['dispatch'];
export type AppThunk<R = void> = ThunkAction<R, RootState, RuntimeDeps, Action>;
