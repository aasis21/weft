import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  JSX,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  ReactNode,
  TouchEvent as ReactTouchEvent,
} from 'react';
import type { HistoryItem } from '@aasis21/helm-shared';
import type { TimelineItem } from '../lib/timeline';
import { Markdown } from './Markdown';
import { ToolCard } from './ToolCard';

interface ChatThreadProps {
  items: TimelineItem[];
  /** Backfilled pre-join turns rendered above the live items, separated by a divider. */
  history?: HistoryItem[];
  /** True while the bound session is live, so we show a caret / working row. */
  streaming?: boolean;
  /** Shown centered when there is nothing yet. */
  emptyHint?: string;
  onRetry?: (itemId: string) => void;
}

const COPILOT_AVATAR: ReactNode = (
  <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
    <path
      fill="currentColor"
      d="M8 0.8l1.7 4.5L14.2 7 9.7 8.7 8 13.2 6.3 8.7 1.8 7l4.5-1.7zM13 10.4l.7 1.9 1.9.7-1.9.7-.7 1.9-.7-1.9L10.4 13l1.9-.7z"
    />
  </svg>
);

const LAPTOP_GLYPH: ReactNode = (
  <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
    <path
      fill="currentColor"
      d="M3 3.5A1.5 1.5 0 0 1 4.5 2h7A1.5 1.5 0 0 1 13 3.5V10H3V3.5zM2 11h12l1 2.2a.5.5 0 0 1-.46.8H1.46A.5.5 0 0 1 1 13.2L2 11z"
    />
  </svg>
);

const PHONE_GLYPH: ReactNode = (
  <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
    <path
      fill="currentColor"
      d="M5 1.5A1.5 1.5 0 0 1 6.5 0h3A1.5 1.5 0 0 1 11 1.5v13A1.5 1.5 0 0 1 9.5 16h-3A1.5 1.5 0 0 1 5 14.5v-13zM6.5 13a.5.5 0 0 0 0 1h3a.5.5 0 0 0 0-1h-3z"
    />
  </svg>
);

/** A muted chip attributing a user prompt to the device that typed it. */
function DeviceChip({ origin }: { origin?: 'phone' | 'terminal' }): JSX.Element | null {
  if (origin !== 'phone' && origin !== 'terminal') return null;
  const laptop = origin === 'terminal';
  return (
    <span className={`device-chip ${laptop ? 'laptop' : 'phone'}`}>
      <span className="device-glyph" aria-hidden="true">
        {laptop ? LAPTOP_GLYPH : PHONE_GLYPH}
      </span>
      {laptop ? 'Laptop' : 'This phone'}
    </span>
  );
}

function isAssistantSide(item: TimelineItem | undefined): boolean {
  return !!item && (item.kind === 'assistant' || item.kind === 'tool');
}

function formatTime(ts: number): string {
  return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(ts);
}

type ToolTimelineItem = Extract<TimelineItem, { kind: 'tool' }>;
type RenderUnit =
  | { kind: 'item'; item: TimelineItem; index: number }
  | { kind: 'tool-run'; id: string; items: ToolTimelineItem[]; startIndex: number };

interface MenuState {
  itemId: string;
  text: string;
  x: number;
  y: number;
}

export function ChatThread({ items, history = [], streaming = false, emptyHint, onRetry }: ChatThreadProps): JSX.Element {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const copyTimerRef = useRef<number | null>(null);
  const liveTimerRef = useRef<number | null>(null);
  const longPressTimerRef = useRef<number | null>(null);
  const lastLiveSignalRef = useRef<string>('');
  // True while the viewport is parked at (or near) the bottom. When the user has
  // scrolled up to read history we must not yank them back down — we only stick to
  // the bottom if they were already there (or just sent a prompt themselves).
  const pinnedRef = useRef(true);
  const [isPinned, setIsPinned] = useState(true);
  const [hasNewWhileUnpinned, setHasNewWhileUnpinned] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [collapsedToolRuns, setCollapsedToolRuns] = useState<Record<string, boolean>>({});
  const [liveText, setLiveText] = useState('');

  const last = items[items.length - 1];
  const lastText = last && 'text' in last ? last.text : last?.kind;
  const lastIsUser = last?.kind === 'user';
  const initialLoading = items.length === 0 && history.length === 0 && streaming;
  const renderUnits = useMemo<RenderUnit[]>(() => {
    const units: RenderUnit[] = [];
    let index = 0;

    while (index < items.length) {
      const item = items[index];
      if (!item) break;
      if (item.kind !== 'tool') {
        units.push({ kind: 'item', item, index });
        index += 1;
        continue;
      }

      const startIndex = index;
      const run: ToolTimelineItem[] = [];
      while (index < items.length) {
        const tool = items[index];
        if (!tool || tool.kind !== 'tool') break;
        run.push(tool);
        index += 1;
      }

      const firstTool = run[0];
      if (run.length >= 3 && firstTool) {
        units.push({ kind: 'tool-run', id: `tool-run-${firstTool.id}-${run.length}`, items: run, startIndex });
      } else {
        run.forEach((tool, offset) => units.push({ kind: 'item', item: tool, index: startIndex + offset }));
      }
    }

    return units;
  }, [items]);

  const cancelLongPress = useCallback((): void => {
    if (longPressTimerRef.current !== null) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }, []);

  const openMenu = useCallback((itemId: string, text: string, x: number, y: number): void => {
    setMenu({ itemId, text, x, y });
  }, []);

  const copyText = useCallback(async (itemId: string, text: string): Promise<void> => {
    try {
      await navigator.clipboard?.writeText(text);
      setCopiedId(itemId);
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
      copyTimerRef.current = window.setTimeout(() => setCopiedId(null), 1200);
    } catch {
      setCopiedId(null);
    }
  }, []);

  const copyFromMenu = useCallback((): void => {
    if (!menu) return;
    void copyText(menu.itemId, menu.text);
    setMenu(null);
  }, [copyText, menu]);

  const handleContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLElement>, itemId: string, text: string): void => {
      event.preventDefault();
      cancelLongPress();
      openMenu(itemId, text, event.clientX, event.clientY);
    },
    [cancelLongPress, openMenu],
  );

  const handleBubbleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLElement>, itemId: string, text: string): void => {
      if (event.key !== 'ContextMenu' && !(event.key === 'F10' && event.shiftKey)) return;
      event.preventDefault();
      const rect = event.currentTarget.getBoundingClientRect();
      openMenu(itemId, text, rect.left + rect.width / 2, rect.top + rect.height / 2);
    },
    [openMenu],
  );

  const handleTouchStart = useCallback(
    (event: ReactTouchEvent<HTMLElement>, itemId: string, text: string): void => {
      cancelLongPress();
      const touch = event.touches[0];
      if (!touch) return;
      longPressTimerRef.current = window.setTimeout(() => {
        openMenu(itemId, text, touch.clientX, touch.clientY);
      }, 500);
    },
    [cancelLongPress, openMenu],
  );

  const scrollToLatest = useCallback((): void => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    pinnedRef.current = true;
    setIsPinned(true);
    setHasNewWhileUnpinned(false);
  }, []);

  // Track how far the reader is from the bottom of the scrolling ancestor.
  useEffect(() => {
    const scroller = rootRef.current?.closest('.thread-scroll') as HTMLElement | null;
    if (!scroller) return undefined;
    const update = (): void => {
      cancelLongPress();
      const gap = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
      const nextPinned = gap < 80;
      pinnedRef.current = nextPinned;
      setIsPinned(nextPinned);
      if (nextPinned) setHasNewWhileUnpinned(false);
    };
    update();
    scroller.addEventListener('scroll', update, { passive: true });
    return () => scroller.removeEventListener('scroll', update);
  }, [cancelLongPress]);

  // Auto-scroll only when genuinely new content arrives (never on a Live/Quiet
  // heartbeat flip), and only if the reader is pinned to the bottom or just sent.
  useEffect(() => {
    if (!pinnedRef.current && !lastIsUser) {
      setHasNewWhileUnpinned(true);
      return;
    }
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [items.length, lastText, lastIsUser]);

  useEffect(() => {
    const signal = streaming ? 'working' : last?.kind === 'assistant' ? `assistant-${last.id}` : '';
    if (!signal || signal === lastLiveSignalRef.current) return undefined;
    lastLiveSignalRef.current = signal;
    if (liveTimerRef.current !== null) window.clearTimeout(liveTimerRef.current);
    liveTimerRef.current = window.setTimeout(() => {
      setLiveText(signal === 'working' ? 'Assistant is working' : 'Assistant replied');
    }, 200);
    return () => {
      if (liveTimerRef.current !== null) window.clearTimeout(liveTimerRef.current);
    };
  }, [last?.id, last?.kind, streaming]);

  useEffect(() => {
    if (!menu) return undefined;
    const handlePointerDown = (event: PointerEvent): void => {
      if (menuRef.current?.contains(event.target as Node)) return;
      setMenu(null);
    };
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setMenu(null);
    };
    window.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [menu]);

  useEffect(() => {
    return () => {
      cancelLongPress();
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
      if (liveTimerRef.current !== null) window.clearTimeout(liveTimerRef.current);
    };
  }, [cancelLongPress]);

  const showThinking = streaming && (!last || last.kind === 'user' || last.kind === 'notice');

  return (
    <div className="chat-thread" ref={rootRef}>
      <div aria-live="polite" className="sr-only">
        {liveText}
      </div>

      {initialLoading ? (
        <div className="thread-skeleton" aria-label="Loading conversation">
          <div className="skeleton-line" />
          <div className="skeleton-line" />
          <div className="skeleton-line" />
        </div>
      ) : null}

      {items.length === 0 && history.length === 0 && !initialLoading ? (
        <div className="thread-empty-rich">
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path
              fill="currentColor"
              d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3zm6 11l.9 2.1L21 17l-2.1.9L18 20l-.9-2.1L15 17l2.1-.9L18 14z"
            />
          </svg>
          <h2>Start a secure Copilot thread</h2>
          <p>{emptyHint ?? 'Ask for help with code, commands, or the current repo from this phone.'}</p>
          <div>
            <span className="empty-suggest">Explain this repo</span>
            <span className="empty-suggest">Run the tests</span>
            <span className="empty-suggest">Fix the failing build</span>
          </div>
        </div>
      ) : null}

      {history.length > 0 ? (
        <div className="history-block">
          {history.map((h) => {
            if (h.role === 'user') {
              return (
                <div key={`h-${h.turnIndex}-user`} className="row user history">
                  <div
                    className="bubble user-bubble"
                    tabIndex={0}
                    onContextMenu={(event) => handleContextMenu(event, `h-${h.turnIndex}-user`, h.text)}
                    onKeyDown={(event) => handleBubbleKeyDown(event, `h-${h.turnIndex}-user`, h.text)}
                    onTouchStart={(event) => handleTouchStart(event, `h-${h.turnIndex}-user`, h.text)}
                    onTouchEnd={cancelLongPress}
                    onTouchMove={cancelLongPress}
                    onTouchCancel={cancelLongPress}
                  >
                    {h.text}
                  </div>
                  <span className="ts user-ts">{formatTime(h.ts)}</span>
                </div>
              );
            }
            return (
              <div key={`h-${h.turnIndex}-assistant`} className="row assistant history turn-start">
                <div className="meta">
                  <span className="avatar copilot">{COPILOT_AVATAR}</span>
                  <span className="role">Copilot</span>
                  <span className="ts">{formatTime(h.ts)}</span>
                </div>
                <div
                  className="bubble assistant-bubble"
                  tabIndex={0}
                  onContextMenu={(event) => handleContextMenu(event, `h-${h.turnIndex}-assistant`, h.text)}
                  onKeyDown={(event) => handleBubbleKeyDown(event, `h-${h.turnIndex}-assistant`, h.text)}
                  onTouchStart={(event) => handleTouchStart(event, `h-${h.turnIndex}-assistant`, h.text)}
                  onTouchEnd={cancelLongPress}
                  onTouchMove={cancelLongPress}
                  onTouchCancel={cancelLongPress}
                >
                  <Markdown text={h.text} />
                </div>
                <button
                  type="button"
                  className="msg-copy"
                  aria-label="Copy message"
                  onClick={() => void copyText(`h-${h.turnIndex}-assistant`, h.text)}
                >
                  {copiedId === `h-${h.turnIndex}-assistant` ? 'Copied' : 'Copy'}
                </button>
              </div>
            );
          })}
          <div className="history-divider" role="separator">
            <span>Earlier in this session</span>
          </div>
        </div>
      ) : null}

      {renderUnits.map((unit) => {
        if (unit.kind === 'tool-run') {
          const firstTool = unit.items[0];
          if (!firstTool) return null;
          const prev = items[unit.startIndex - 1];
          const turnStart = !isAssistantSide(prev);
          const collapsed = Boolean(collapsedToolRuns[unit.id]);
          const header = turnStart ? (
            <div className="meta">
              <span className="avatar copilot">{COPILOT_AVATAR}</span>
              <span className="role">Copilot</span>
              <span className="ts">{formatTime(firstTool.ts)}</span>
            </div>
          ) : null;

          return (
            <div key={unit.id} className="tool-run-group">
              {header}
              <button
                type="button"
                className="tool-run-toggle"
                aria-expanded={!collapsed}
                onClick={() => setCollapsedToolRuns((runs) => ({ ...runs, [unit.id]: !collapsed }))}
              >
                {unit.items.length} tool steps
              </button>
              {!collapsed
                ? unit.items.map((tool) => (
                    <div key={tool.id} className="row tool">
                      <ToolCard item={tool} />
                    </div>
                  ))
                : null}
            </div>
          );
        }

        const { item, index: idx } = unit;
        const prev = items[idx - 1];
        const turnStart = isAssistantSide(item) && !isAssistantSide(prev);
        const isLast = idx === items.length - 1;

        if (item.kind === 'user') {
          return (
            <div key={item.id} className="row user">
              <div
                className="bubble user-bubble"
                tabIndex={0}
                onContextMenu={(event) => handleContextMenu(event, item.id, item.text)}
                onKeyDown={(event) => handleBubbleKeyDown(event, item.id, item.text)}
                onTouchStart={(event) => handleTouchStart(event, item.id, item.text)}
                onTouchEnd={cancelLongPress}
                onTouchMove={cancelLongPress}
                onTouchCancel={cancelLongPress}
              >
                {item.text}
              </div>
              <span className="ts user-ts">{formatTime(item.ts)}</span>
              {item.failed ? (
                <div
                  className="notice warning"
                  role="alert"
                  style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', justifyContent: 'flex-end' }}
                >
                  <span className="notice-text">Not delivered</span>
                  {onRetry ? (
                    <button
                      type="button"
                      className="reconnect-btn"
                      aria-label="Retry sending message"
                      onClick={() => onRetry(item.id)}
                    >
                      Retry
                    </button>
                  ) : null}
                </div>
              ) : null}
              <DeviceChip origin={item.origin} />
            </div>
          );
        }

        if (item.kind === 'notice') {
          return (
            <div key={item.id} className={`row notice ${item.level}`}>
              <span className="notice-text">{item.text}</span>
            </div>
          );
        }

        const header = turnStart ? (
          <div className="meta">
            <span className="avatar copilot">{COPILOT_AVATAR}</span>
            <span className="role">Copilot</span>
            <span className="ts">{formatTime(item.ts)}</span>
          </div>
        ) : null;

        if (item.kind === 'tool') {
          return (
            <div key={item.id} className={`row tool${turnStart ? ' turn-start' : ''}`}>
              {header}
              <ToolCard item={item} />
            </div>
          );
        }

        const caret = streaming && isLast;
        return (
          <div key={item.id} className={`row assistant${turnStart ? ' turn-start' : ''}`}>
            {header}
            <div
              className="bubble assistant-bubble"
              tabIndex={0}
              onContextMenu={(event) => handleContextMenu(event, item.id, item.text)}
              onKeyDown={(event) => handleBubbleKeyDown(event, item.id, item.text)}
              onTouchStart={(event) => handleTouchStart(event, item.id, item.text)}
              onTouchEnd={cancelLongPress}
              onTouchMove={cancelLongPress}
              onTouchCancel={cancelLongPress}
            >
              <Markdown text={item.text} />
              {caret ? <span className="caret" aria-hidden="true" /> : null}
            </div>
            <button
              type="button"
              className="msg-copy"
              aria-label="Copy message"
              onClick={() => void copyText(item.id, item.text)}
            >
              {copiedId === item.id ? 'Copied' : 'Copy'}
            </button>
          </div>
        );
      })}

      {showThinking ? (
        <div className="row assistant turn-start thinking-row">
          <div className="meta">
            <span className="avatar copilot">{COPILOT_AVATAR}</span>
            <span className="role">Copilot</span>
          </div>
          <div className="thinking">
            <span className="thinking-dots" aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
            <span>working…</span>
          </div>
        </div>
      ) : null}

      {!isPinned ? (
        <button type="button" className="scroll-latest" aria-label="Scroll to latest" onClick={scrollToLatest}>
          {hasNewWhileUnpinned ? <span>New</span> : null}
          <span>Latest</span>
        </button>
      ) : null}

      {menu ? (
        <div
          ref={menuRef}
          className="msg-menu"
          style={{ position: 'fixed', left: menu.x, top: menu.y }}
          role="menu"
        >
          <button type="button" className="msg-menu-item" role="menuitem" onClick={copyFromMenu}>
            Copy
          </button>
        </div>
      ) : null}

      <div ref={endRef} />
    </div>
  );
}
