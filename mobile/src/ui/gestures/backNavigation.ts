import { useEffect, useRef } from 'react';

/**
 * System Back (Android gesture/button, browser Back) closes the top-most open layer first: a
 * sheet, the drawer, a page. Each open layer owns one history entry that carries a copy of the
 * underlying state, so App's and Explore's popstate routing still sees the screen beneath it.
 */

const KEY = 'weftLayer';

/** Return `'stay'` when Back was consumed but the layer is still open (e.g. a nested view). */
export type BackHandler = () => void | 'stay';

interface Layer {
  token: string;
  onBack: BackHandler;
}

const stack: Layer[] = [];
let sequence = 0;
let selfPops = 0;
let listening = false;

function tokenOf(state: unknown): string | undefined {
  if (state && typeof state === 'object' && KEY in state) {
    return String((state as Record<string, unknown>)[KEY]);
  }
  return undefined;
}

function onPopState(event: PopStateEvent): void {
  if (selfPops > 0) {
    selfPops -= 1;
    return;
  }
  const token = tokenOf(event.state);
  const keep = token ? stack.findIndex((layer) => layer.token === token) + 1 : 0;
  const closing = stack.splice(keep).reverse();
  for (const layer of closing) {
    if (layer.onBack() === 'stay') push(layer);
  }
}

function push(layer: Layer): void {
  if (!listening) {
    window.addEventListener('popstate', onPopState);
    listening = true;
  }
  layer.token = `l${++sequence}`;
  const current: unknown = window.history.state;
  const base = current && typeof current === 'object' ? { ...(current as Record<string, unknown>) } : {};
  delete base[KEY];
  const next = { ...base, [KEY]: layer.token };
  const topToken = tokenOf(current);
  // A layer closed by tap leaves its entry on top for a moment; reuse it instead of stacking.
  if (topToken && !stack.some((open) => open.token === topToken)) window.history.replaceState(next, '');
  else window.history.pushState(next, '');
  stack.push(layer);
}

function release(layer: Layer): void {
  const index = stack.indexOf(layer);
  if (index < 0) return;
  stack.splice(index, 1);
  const token = layer.token;
  // Deferred so a layer opened in the same tap (drawer → Settings) can take over this entry.
  window.setTimeout(() => {
    if (tokenOf(window.history.state) !== token) return;
    selfPops += 1;
    window.history.back();
  }, 0);
}

/** While `active`, system Back runs `onBack` instead of leaving the screen. */
export function useBackHandler(active: boolean, onBack: BackHandler): void {
  const onBackRef = useRef(onBack);
  onBackRef.current = onBack;
  useEffect(() => {
    if (!active) return undefined;
    const layer: Layer = { token: '', onBack: () => onBackRef.current() };
    push(layer);
    return () => release(layer);
  }, [active]);
}
