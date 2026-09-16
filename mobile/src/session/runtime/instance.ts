import { createSessionRuntime } from './sessionRuntime';
import { RuntimeSessionAccess } from '@/session/access/sessionAccess';

/**
 * The app-wide session runtime. One store, one transport registry, one watchdog for the whole
 * SHELL — the drop-in replacement for the old `sessionManager` singleton. Tests never import this;
 * they build isolated runtimes via `createSessionRuntime()` so state can't bleed between cases.
 */
export const sessionRuntime = createSessionRuntime();
export const sessionAccess = new RuntimeSessionAccess(sessionRuntime);
