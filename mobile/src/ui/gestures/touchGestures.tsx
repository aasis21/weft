import { useEffect, useRef, useState } from 'react';
import type { JSX, RefObject, TouchEvent as ReactTouchEvent } from 'react';

/** A short tick when a gesture commits. Silent where the platform has no vibration (iOS). */
export function hapticTick(): void {
  try {
    navigator.vibrate?.(10);
  } catch {
    // Some browsers throw without a user activation; the gesture still works.
  }
}

function textEntryFocused(): boolean {
  const el = document.activeElement;
  return el instanceof HTMLTextAreaElement ||
    (el instanceof HTMLInputElement && !['button', 'checkbox', 'radio', 'submit'].includes(el.type)) ||
    (el instanceof HTMLElement && el.isContentEditable);
}

/** Touches must start this close to the left edge; wider than Android's system back inset. */
const EDGE_PX = 40;

/** Swipe right from the left edge opens the sessions drawer. */
export function useLeftEdgeSwipe(enabled: boolean, onOpen: () => void): void {
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;
  useEffect(() => {
    if (!enabled) return undefined;
    let start: { x: number; y: number; at: number } | null = null;
    const onStart = (event: TouchEvent): void => {
      start = null;
      const touch = event.touches[0];
      if (event.touches.length !== 1 || !touch || touch.clientX > EDGE_PX) return;
      if (textEntryFocused() || document.querySelector('[role="dialog"], [aria-modal="true"]')) return;
      start = { x: touch.clientX, y: touch.clientY, at: performance.now() };
    };
    const onEnd = (event: TouchEvent): void => {
      const began = start;
      start = null;
      const touch = event.changedTouches[0];
      if (!began || !touch) return;
      const dx = touch.clientX - began.x;
      const dy = Math.abs(touch.clientY - began.y);
      const velocity = dx / Math.max(1, performance.now() - began.at);
      const far = dx >= Math.max(64, window.innerWidth * 0.2);
      if (dx > dy * 1.5 && (far || (dx >= 32 && velocity >= 0.5))) {
        hapticTick();
        onOpenRef.current();
      }
    };
    const onCancel = (): void => { start = null; };
    window.addEventListener('touchstart', onStart, { passive: true });
    window.addEventListener('touchend', onEnd, { passive: true });
    window.addEventListener('touchcancel', onCancel, { passive: true });
    return () => {
      window.removeEventListener('touchstart', onStart);
      window.removeEventListener('touchend', onEnd);
      window.removeEventListener('touchcancel', onCancel);
    };
  }, [enabled]);
}

/** Swipe left on an open drawer (or its scrim) closes it; the panel follows the finger. */
export function useSwipeToClose(
  panelRef: RefObject<HTMLElement | null>,
  enabled: boolean,
  onClose: () => void,
): { onTouchStart(event: ReactTouchEvent): void; onTouchMove(event: ReactTouchEvent): void; onTouchEnd(): void } {
  const gesture = useRef<{ x: number; y: number; dx: number; locked: boolean; skip: boolean } | null>(null);
  const reset = (): void => {
    const panel = panelRef.current;
    if (panel) {
      panel.style.transform = '';
      panel.style.transition = '';
    }
  };
  return {
    onTouchStart(event) {
      const touch = event.touches[0];
      const target = event.target as HTMLElement | null;
      // Session rows swipe left to reveal their own actions.
      const skip = !enabled || !touch || event.touches.length !== 1 ||
        !!target?.closest('.session-row:not(.device-drawer-row), input, textarea');
      gesture.current = touch ? { x: touch.clientX, y: touch.clientY, dx: 0, locked: false, skip } : null;
    },
    onTouchMove(event) {
      const g = gesture.current;
      const touch = event.touches[0];
      if (!g || g.skip || !touch) return;
      const dx = touch.clientX - g.x;
      const dy = touch.clientY - g.y;
      if (!g.locked) {
        if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
        if (dx >= 0 || Math.abs(dx) <= Math.abs(dy) * 1.2) {
          g.skip = true;
          return;
        }
        g.locked = true;
      }
      g.dx = Math.min(0, dx);
      const panel = panelRef.current;
      if (panel) {
        panel.style.transition = 'none';
        panel.style.transform = `translateX(${g.dx}px)`;
      }
    },
    onTouchEnd() {
      const g = gesture.current;
      gesture.current = null;
      if (!g || !g.locked) return;
      const width = panelRef.current?.offsetWidth ?? 280;
      reset();
      if (-g.dx >= Math.min(96, width * 0.3)) {
        hapticTick();
        onClose();
      }
    },
  };
}

export interface PullState {
  distance: number;
  refreshing: boolean;
}

const PULL_TRIGGER_PX = 56;
const PULL_MAX_PX = 84;
const REFRESH_MIN_MS = 700;

/** Pull down at the top of `scrollRef` to refresh. Render {@link PullIndicator} inside it. */
export function usePullToRefresh(
  scrollRef: RefObject<HTMLElement | null>,
  onRefresh: () => unknown,
  enabled = true,
): PullState {
  const [state, setState] = useState<PullState>({ distance: 0, refreshing: false });
  const onRefreshRef = useRef(onRefresh);
  onRefreshRef.current = onRefresh;
  const refreshingRef = useRef(false);
  useEffect(() => {
    const el = scrollRef.current;
    if (!enabled || !el) return undefined;
    let start: { x: number; y: number } | null = null;
    let locked = false;
    let distance = 0;
    const onStart = (event: TouchEvent): void => {
      const touch = event.touches[0];
      start = event.touches.length === 1 && touch && el.scrollTop <= 0 && !refreshingRef.current
        ? { x: touch.clientX, y: touch.clientY }
        : null;
      locked = false;
      distance = 0;
    };
    const onMove = (event: TouchEvent): void => {
      const touch = event.touches[0];
      if (!start || !touch) return;
      const dx = touch.clientX - start.x;
      const dy = touch.clientY - start.y;
      if (!locked) {
        if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
        if (dy <= 0 || dy <= Math.abs(dx) * 1.2 || el.scrollTop > 0) {
          start = null;
          return;
        }
        locked = true;
      }
      if (event.cancelable) event.preventDefault();
      distance = Math.min(PULL_MAX_PX, Math.max(0, dy * 0.5));
      setState({ distance, refreshing: false });
    };
    const onEnd = (): void => {
      if (!locked) {
        start = null;
        return;
      }
      start = null;
      locked = false;
      if (distance < PULL_TRIGGER_PX) {
        setState({ distance: 0, refreshing: false });
        return;
      }
      hapticTick();
      refreshingRef.current = true;
      setState({ distance: 0, refreshing: true });
      const began = Date.now();
      void Promise.resolve()
        .then(() => onRefreshRef.current())
        .catch(() => undefined)
        .then(() => new Promise((resolve) => window.setTimeout(resolve, Math.max(0, REFRESH_MIN_MS - (Date.now() - began)))))
        .then(() => {
          refreshingRef.current = false;
          setState({ distance: 0, refreshing: false });
        });
    };
    el.addEventListener('touchstart', onStart, { passive: true });
    el.addEventListener('touchmove', onMove, { passive: false });
    el.addEventListener('touchend', onEnd, { passive: true });
    el.addEventListener('touchcancel', onEnd, { passive: true });
    return () => {
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchmove', onMove);
      el.removeEventListener('touchend', onEnd);
      el.removeEventListener('touchcancel', onEnd);
    };
  }, [scrollRef, enabled]);
  return state;
}

export function PullIndicator({ state }: { state: PullState }): JSX.Element | null {
  if (!state.refreshing && state.distance === 0) return null;
  const ready = state.distance >= PULL_TRIGGER_PX;
  return (
    <div
      className={`pull-indicator${state.refreshing ? ' refreshing' : ''}`}
      style={{ height: state.refreshing ? 40 : state.distance }}
      role="status"
    >
      {state.refreshing ? (
        <><span className="pull-spinner" aria-hidden="true" />Refreshing…</>
      ) : (
        <><span className={`pull-arrow${ready ? ' ready' : ''}`} aria-hidden="true">↓</span>{ready ? 'Release to refresh' : 'Pull to refresh'}</>
      )}
    </div>
  );
}

/** Swipe down on a focused text box hides the keyboard. */
export function swipeDownToHideKeyboard(): {
  onTouchStart(event: ReactTouchEvent<HTMLTextAreaElement>): void;
  onTouchMove(event: ReactTouchEvent<HTMLTextAreaElement>): void;
} {
  return {
    onTouchStart(event) {
      const touch = event.touches[0];
      const el = event.currentTarget;
      el.dataset.swipeY = touch && document.activeElement === el && el.scrollTop <= 0 ? String(touch.clientY) : '';
      el.dataset.swipeX = touch ? String(touch.clientX) : '';
    },
    onTouchMove(event) {
      const el = event.currentTarget;
      const touch = event.touches[0];
      if (!el.dataset.swipeY || !touch) return;
      const dy = touch.clientY - Number(el.dataset.swipeY);
      const dx = Math.abs(touch.clientX - Number(el.dataset.swipeX));
      if (dy >= 36 && dy > dx * 1.5) {
        el.dataset.swipeY = '';
        el.blur();
      }
    },
  };
}
