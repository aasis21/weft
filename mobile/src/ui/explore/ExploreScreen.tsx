import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type {
  JSX,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from 'react';
import type { SessionView } from '@/session/view';
import type { TimelineItem, ToolItem } from '@/lib/timeline';
import { isWorking } from '@/ui/sessions/sessionStatus';
import {
  DISCOVER_CARDS,
  DISCOVER_TOPIC_LABELS,
  type DiscoverCard,
  type DiscoverTopic,
} from './discoverCards';

export type ExploreCategory = 'discover' | 'watch' | 'play' | 'unwind';
type ExploreView = ExploreCategory | null;
type ExploreHistoryState = {
  weftView: 'explore';
  exploreView?: ExploreCategory;
};

function historyExploreView(state: ExploreHistoryState | null): ExploreView {
  const candidate = state?.exploreView;
  return candidate === 'discover' ||
    candidate === 'watch' ||
    candidate === 'play' ||
    candidate === 'unwind'
    ? candidate
    : null;
}

interface ExploreScreenProps {
  active: SessionView;
  onOpenSessions(): void;
  onOpenChat(): void;
  onGoHome(): void;
  desktopDocked?: boolean;
}

export type LiveDockTone = 'attention' | 'error' | 'working' | 'ready' | 'idle';

export interface LiveDockState {
  tone: LiveDockTone;
  label: string;
  text: string;
  detail: string | null;
  startedAt: number | null;
}

const CATEGORY_META: Record<ExploreCategory, { title: string; subtitle: string; icon: JSX.Element }> = {
  discover: {
    title: 'Discover',
    subtitle: 'Read something worth knowing',
    icon: <CompassSpark />,
  },
  watch: {
    title: 'Watch',
    subtitle: 'Short visual content',
    icon: <PlayGlyph />,
  },
  play: {
    title: 'Play',
    subtitle: 'Puzzles and mini-games',
    icon: <DiamondGlyph />,
  },
  unwind: {
    title: 'Unwind',
    subtitle: 'Breathe, reset, and rest',
    icon: <WaveGlyph />,
  },
};

const STORAGE_KEY = 'weft.explore.v1';

interface ExploreStoredState {
  lastCategory?: ExploreCategory;
  completedCardIds?: string[];
  discoverDay?: string;
  discoverCycle?: number;
  discoverIndex?: number;
  threadlineCompleted?: number;
  signalBest?: number;
  vibration?: boolean;
}

const DEFAULT_STORED_STATE: Required<ExploreStoredState> = {
  lastCategory: 'discover',
  completedCardIds: [],
  discoverDay: '',
  discoverCycle: 0,
  discoverIndex: 0,
  threadlineCompleted: 0,
  signalBest: 0,
  vibration: false,
};

function parseStoredState(): Required<ExploreStoredState> {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_STORED_STATE;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const lastCategory =
      parsed.lastCategory === 'discover' ||
      parsed.lastCategory === 'watch' ||
      parsed.lastCategory === 'play' ||
      parsed.lastCategory === 'unwind'
        ? parsed.lastCategory
        : DEFAULT_STORED_STATE.lastCategory;
    const state: Required<ExploreStoredState> = {
      lastCategory,
      completedCardIds: Array.isArray(parsed.completedCardIds)
        ? parsed.completedCardIds.filter((value): value is string => typeof value === 'string')
        : [],
      discoverDay: typeof parsed.discoverDay === 'string' ? parsed.discoverDay : '',
      discoverCycle:
        typeof parsed.discoverCycle === 'number' && parsed.discoverCycle >= 0
          ? Math.floor(parsed.discoverCycle)
          : 0,
      discoverIndex:
        typeof parsed.discoverIndex === 'number' && parsed.discoverIndex >= 0
          ? Math.floor(parsed.discoverIndex)
          : 0,
      threadlineCompleted:
        typeof parsed.threadlineCompleted === 'number' && parsed.threadlineCompleted >= 0
          ? Math.floor(parsed.threadlineCompleted)
          : 0,
      signalBest:
        typeof parsed.signalBest === 'number' && parsed.signalBest >= 0 ? Math.floor(parsed.signalBest) : 0,
      vibration: parsed.vibration === true,
    };
    const legacyCardPreferenceKey = 'savedCardIds';
    if (legacyCardPreferenceKey in parsed) {
      globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(state));
    }
    return state;
  } catch {
    return DEFAULT_STORED_STATE;
  }
}

function writeStoredState(state: Required<ExploreStoredState>): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Explore remains fully usable when local persistence is unavailable.
  }
}

function latestRunningTool(active: SessionView): ToolItem | null {
  return (
    [...active.timeline.items]
      .reverse()
      .find((item): item is ToolItem => item.kind === 'tool' && item.status === 'running') ?? null
  );
}

function toolLabel(tool: ToolItem): string {
  const record =
    tool.args && typeof tool.args === 'object' ? (tool.args as Record<string, unknown>) : undefined;
  const description = typeof record?.description === 'string' ? record.description.trim() : '';
  if (description) return description;
  return `${tool.name.replace(/[_-]+/g, ' ')} in progress`;
}

function latestAssistant(active: SessionView, onlyStreaming = false) {
  return [...active.timeline.items].reverse().find(
    (item) => item.kind === 'assistant' && (!onlyStreaming || !item.final) && item.text.trim(),
  );
}

function latestAssistantText(active: SessionView, onlyStreaming = false): string | null {
  const assistant = latestAssistant(active, onlyStreaming);
  return assistant?.kind === 'assistant' ? assistant.text : null;
}

function dockExcerpt(value: string, max = 220): string {
  const clean = value.replace(/[`*_>#-]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  return `…${clean.slice(clean.length - max + 1)}`;
}

export function deriveLiveDock(active: SessionView, replyCompletedInExplore = false): LiveDockState {
  if (active.timeline.approvals.length > 0) {
    const count = active.timeline.approvals.length;
    const request = active.timeline.approvals[0];
    return {
      tone: 'attention',
      label: 'Approval needed',
      text: request.toolName || 'Copilot needs permission to continue',
      detail: `${count} action${count === 1 ? '' : 's'} waiting in chat`,
      startedAt: null,
    };
  }
  if (active.timeline.elicitations.length > 0) {
    return {
      tone: 'attention',
      label: 'Question waiting',
      text: 'Copilot needs your answer to continue',
      detail: 'Open chat to respond',
      startedAt: null,
    };
  }
  if (active.error) {
    return {
      tone: 'error',
      label: 'Session disconnected',
      text: dockExcerpt(active.error),
      detail: 'Open chat to reconnect',
      startedAt: null,
    };
  }
  if (active.status === 'ended') {
    return {
      tone: 'error',
      label: 'Session ended',
      text: active.timeline.endedReason ?? 'Return to chat to reconnect.',
      detail: 'Open chat for session options',
      startedAt: null,
    };
  }
  if (isWorking(active.timeline)) {
    const running = latestRunningTool(active);
    const streamed = latestAssistantText(active, true);
    return {
      tone: 'working',
      label: streamed ? 'Copilot is writing' : 'Copilot is working',
      text: streamed
        ? dockExcerpt(streamed)
        : active.intent?.trim() || (running ? toolLabel(running) : 'Working in the active session'),
      detail: running ? `Using ${running.name.replace(/[_-]+/g, ' ')}` : active.intent?.trim() || null,
      startedAt: active.thinkingSince ?? running?.startedAt ?? active.timeline.busyFrom,
    };
  }
  if (replyCompletedInExplore || active.unread || (active.unreadCount ?? 0) > 0) {
    const reply = latestAssistantText(active);
    return {
      tone: 'ready',
      label: 'Reply ready',
      text: reply ? dockExcerpt(reply) : 'Copilot finished responding',
      detail: 'Open chat to continue',
      startedAt: null,
    };
  }
  const recent = latestAssistantText(active);
  return {
    tone: 'idle',
    label: active.status === 'live' ? 'Copilot ready' : 'Session quiet',
    text: recent ? dockExcerpt(recent) : recentActivityLabel(active.timeline.items),
    detail: null,
    startedAt: null,
  };
}

function recentActivityLabel(items: TimelineItem[]): string {
  const latest = [...items].reverse().find((item) => item.kind !== 'user');
  if (!latest) return 'No recent agent activity';
  if (latest.kind === 'assistant') return 'Last response is available in chat';
  if (latest.kind === 'tool') {
    return latest.status === 'success'
      ? `${latest.name} completed`
      : latest.status === 'error'
        ? `${latest.name} reported an error`
        : `${latest.name} is running`;
  }
  return latest.text;
}

function formatElapsed(startedAt: number | null, now: number): string | null {
  if (startedAt == null) return null;
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return minutes > 0 ? `${minutes}:${remainder.toString().padStart(2, '0')}` : `${seconds}s`;
}

function CompassGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
      <circle cx="12" cy="12" r="8.5" />
      <path d="m14.8 9.2-1.7 3.9-3.9 1.7 1.7-3.9 3.9-1.7Z" />
    </svg>
  );
}

function CompassSpark(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
      <path d="M12 3.5 14.2 9l5.5 2.2-5.5 2.2L12 19l-2.2-5.6-5.5-2.2L9.8 9 12 3.5Z" />
    </svg>
  );
}

function PlayGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
      <path d="m9 6 9 6-9 6V6Z" />
    </svg>
  );
}

function DiamondGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
      <path d="m12 3.5 8.5 8.5-8.5 8.5L3.5 12 12 3.5Z" />
      <circle cx="12" cy="12" r="2.2" />
    </svg>
  );
}

function WaveGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
      <path d="M3 12c2.2-4.6 4.4-4.6 6.5 0s4.3 4.6 6.5 0 4.3-4.6 5 0" />
    </svg>
  );
}

export function ExploreScreen({
  active,
  onOpenSessions,
  onOpenChat,
  onGoHome,
  desktopDocked = false,
}: ExploreScreenProps): JSX.Element {
  const [stored, setStored] = useState<Required<ExploreStoredState>>(() => parseStoredState());
  const [view, setView] = useState<ExploreView>(null);
  const [now, setNow] = useState(Date.now());
  const latestFinal = latestAssistant(active);
  const latestFinalId =
    latestFinal?.kind === 'assistant' && latestFinal.final ? latestFinal.id : null;
  const working = isWorking(active.timeline);
  const replyTrackerRef = useRef({
    channelId: active.meta.channelId,
    wasWorking: working,
    baselineFinalId: latestFinalId,
  });
  const [replyReadyId, setReplyReadyId] = useState<string | null>(null);
  useEffect(() => {
    const tracker = replyTrackerRef.current;
    if (tracker.channelId !== active.meta.channelId) {
      replyTrackerRef.current = {
        channelId: active.meta.channelId,
        wasWorking: working,
        baselineFinalId: latestFinalId,
      };
      setReplyReadyId(null);
      return;
    }
    if (!tracker.wasWorking && working) {
      tracker.baselineFinalId = latestFinalId;
      setReplyReadyId(null);
    } else if (
      tracker.wasWorking &&
      !working &&
      latestFinalId &&
      latestFinalId !== tracker.baselineFinalId
    ) {
      setReplyReadyId(latestFinalId);
    }
    tracker.wasWorking = working;
  }, [active.meta.channelId, latestFinalId, working]);
  const replyCompletedInExplore =
    replyTrackerRef.current.channelId === active.meta.channelId &&
    !working &&
    latestFinalId === replyReadyId;
  const dock = deriveLiveDock(active, replyCompletedInExplore);

  useEffect(() => {
    if (dock.tone !== 'working') return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [dock.tone]);

  useEffect(() => {
    const onPopState = (event: PopStateEvent): void => {
      const state = event.state as ExploreHistoryState | null;
      if (state?.weftView !== 'explore') return;
      setView(historyExploreView(state));
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const updateStored = useCallback((next: Required<ExploreStoredState>): void => {
    setStored(next);
    writeStoredState(next);
  }, []);

  const navigate = (next: ExploreCategory): void => {
    const state = { weftView: 'explore', exploreView: next } satisfies ExploreHistoryState;
    if (view === null) window.history.pushState(state, '');
    else window.history.replaceState(state, '');
    setView(next);
  };

  const openCategory = (category: ExploreCategory): void => {
    updateStored({ ...stored, lastCategory: category });
    navigate(category);
  };

  return (
    <main className={`weft-session explore-screen${desktopDocked ? ' desktop-docked' : ''}`}>
      <div className="explore-content">
        <header className="explore-header">
          {desktopDocked ? (
            <button type="button" className="icon-btn weft-mark-btn" aria-label="About Weft" onClick={onGoHome}>
              <span className="weft-mark" aria-hidden="true">⎈</span>
            </button>
          ) : (
            <button
              type="button"
              className="icon-btn drawer-btn"
              aria-label={(active.unreadCount ?? 0) > 0 ? `Open sessions, ${active.unreadCount} unread` : 'Open sessions'}
              onClick={onOpenSessions}
            >
              <span className="hamburger" aria-hidden="true"><span /><span /><span /></span>
            </button>
          )}
          <div className="explore-heading">
            <span className="explore-heading-icon" aria-hidden="true"><CompassGlyph /></span>
            <strong>Explore</strong>
          </div>
        </header>

        {view === null ? (
          <ExploreHome onOpen={openCategory} />
        ) : (
          <>
            <CategoryTabs active={view} onSelect={openCategory} />
            <div className="explore-category-body">
              {view === 'discover' ? (
                <DiscoverView stored={stored} onChange={updateStored} />
              ) : view === 'watch' ? (
                <WatchView />
              ) : view === 'play' ? (
                <PlayView stored={stored} onChange={updateStored} />
              ) : (
                <UnwindView stored={stored} onChange={updateStored} />
              )}
            </div>
          </>
        )}
        <LiveCopilotDock dock={dock} now={now} onOpenChat={onOpenChat} />
      </div>
    </main>
  );
}

function ExploreHome({
  onOpen,
}: {
  onOpen(category: ExploreCategory): void;
}): JSX.Element {
  return (
    <section className="explore-home" aria-labelledby="explore-question">
      <div className="explore-intro">
        <h1 id="explore-question">What do you feel like?</h1>
      </div>
      <div className="explore-choice-grid">
        {(Object.keys(CATEGORY_META) as ExploreCategory[]).map((category) => {
          const meta = CATEGORY_META[category];
          return (
            <button
              type="button"
              key={category}
              className={`explore-choice explore-choice-${category}`}
              aria-label={`${meta.title}: ${meta.subtitle}`}
              onClick={() => onOpen(category)}
            >
              <span className="explore-choice-icon" aria-hidden="true">{meta.icon}</span>
              <strong>{meta.title}</strong>
              <span>{meta.subtitle}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function CategoryTabs({
  active,
  onSelect,
}: {
  active: ExploreCategory;
  onSelect(category: ExploreCategory): void;
}): JSX.Element {
  return (
    <nav className="explore-tabs" aria-label="Explore categories">
      {(Object.keys(CATEGORY_META) as ExploreCategory[]).map((category) => (
        <button
          type="button"
          key={category}
          className={active === category ? 'active' : ''}
          aria-current={active === category ? 'page' : undefined}
          onClick={() => onSelect(category)}
        >
          {CATEGORY_META[category].title}
        </button>
      ))}
    </nav>
  );
}

function LiveCopilotDock({
  dock,
  now,
  onOpenChat,
}: {
  dock: LiveDockState;
  now: number;
  onOpenChat(): void;
}): JSX.Element {
  const elapsed = formatElapsed(dock.startedAt, now);
  return (
    <button
      type="button"
      className={`live-copilot-dock live-copilot-dock-${dock.tone}`}
      onClick={onOpenChat}
      aria-label={`${dock.label}. ${dock.text}${dock.detail ? `. ${dock.detail}` : ''}${elapsed ? `. ${elapsed}` : ''}. Open chat`}
    >
      <span className="live-copilot-dot" aria-hidden="true" />
      <span className="live-copilot-copy">
        <span className="live-copilot-status">
          <strong>{dock.label}</strong>
          {elapsed ? <time>{elapsed}</time> : null}
        </span>
        <span className="live-copilot-text">{dock.text}</span>
        {dock.detail ? <small>{dock.detail}</small> : null}
      </span>
      <span className="live-copilot-chevron" aria-hidden="true">›</span>
    </button>
  );
}

function shorten(value: string, max: number): string {
  const clean = value.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function discoverDayKey(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function hashSeed(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function shuffleCards(cards: DiscoverCard[], random: () => number): DiscoverCard[] {
  const result = [...cards];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1));
    [result[index], result[target]] = [result[target], result[index]];
  }
  return result;
}

export function buildDiscoverDeck(cards: DiscoverCard[], seed: number): DiscoverCard[] {
  const topics = Object.keys(DISCOVER_TOPIC_LABELS) as DiscoverTopic[];
  const random = seededRandom(seed || 1);
  const start = seed % topics.length;
  const topicOrder = [...topics.slice(start), ...topics.slice(0, start)];
  const buckets = new Map(
    topics.map((topic) => [topic, shuffleCards(cards.filter((card) => card.topic === topic), random)]),
  );
  const result: DiscoverCard[] = [];
  let remaining = cards.length;
  while (remaining > 0) {
    for (const topic of topicOrder) {
      const next = buckets.get(topic)?.shift();
      if (!next) continue;
      result.push(next);
      remaining -= 1;
    }
  }
  return result;
}

function DiscoverView({
  stored,
  onChange,
}: {
  stored: Required<ExploreStoredState>;
  onChange(next: Required<ExploreStoredState>): void;
}): JSX.Element {
  const today = discoverDayKey();
  const cycle = stored.discoverDay === today ? stored.discoverCycle : 0;
  const persistedIndex = stored.discoverDay === today ? stored.discoverIndex : 0;
  const deck = useMemo(
    () => buildDiscoverDeck(DISCOVER_CARDS, hashSeed(`${today}:${cycle}`)),
    [cycle, today],
  );
  const index = Math.min(persistedIndex, Math.max(0, deck.length - 1));
  const card = deck[index];
  const pointerStart = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (
      stored.discoverDay !== today ||
      stored.discoverCycle !== cycle ||
      stored.discoverIndex !== index
    ) {
      onChange({ ...stored, discoverDay: today, discoverCycle: cycle, discoverIndex: index });
    }
  }, [cycle, index, onChange, stored, today]);

  const changeCard = (direction: 1 | -1): void => {
    if (!card) return;
    const completed = stored.completedCardIds.includes(card.id)
      ? stored.completedCardIds
      : [...stored.completedCardIds, card.id];
    if (direction < 0) {
      if (index === 0) return;
      onChange({ ...stored, completedCardIds: completed, discoverDay: today, discoverCycle: cycle, discoverIndex: index - 1 });
      return;
    }
    if (index < deck.length - 1) {
      onChange({ ...stored, completedCardIds: completed, discoverDay: today, discoverCycle: cycle, discoverIndex: index + 1 });
      return;
    }
    onChange({ ...stored, completedCardIds: completed, discoverDay: today, discoverCycle: cycle + 1, discoverIndex: 0 });
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLElement>): void => {
    const start = pointerStart.current;
    pointerStart.current = null;
    if (!start) return;
    const deltaX = event.clientX - start.x;
    const deltaY = event.clientY - start.y;
    if (Math.abs(deltaX) < 48 || Math.abs(deltaX) <= Math.abs(deltaY) * 1.2) return;
    changeCard(deltaX < 0 ? 1 : -1);
  };

  if (!card) return <div className="discover-view">No Discover cards are available.</div>;

  return (
    <section
      className="discover-view"
      aria-label="Discover card deck"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === 'ArrowRight') {
          event.preventDefault();
          changeCard(1);
        } else if (event.key === 'ArrowLeft') {
          event.preventDefault();
          changeCard(-1);
        }
      }}
      onPointerDown={(event) => {
        pointerStart.current = { x: event.clientX, y: event.clientY };
      }}
      onPointerCancel={() => {
        pointerStart.current = null;
      }}
      onPointerUp={onPointerUp}
    >
      <article className="discover-deck-card" aria-live="polite">
        <div className="discover-deck-topline">
          <span>{DISCOVER_TOPIC_LABELS[card.topic]}</span>
          <span>{card.minutes} min</span>
        </div>
        <div className="discover-deck-illustration" aria-hidden="true"><CompassSpark /></div>
        <h1>{card.title}</h1>
        <p className="discover-deck-summary">{card.summary}</p>
        <div className="discover-deck-insight">
          <strong>The useful idea</strong>
          <p>{card.insight}</p>
        </div>
        <div className="discover-deck-actions">
          <span>{index + 1} / {deck.length}</span>
          <div>
            <button type="button" aria-label="Previous Discover card" disabled={index === 0} onClick={() => changeCard(-1)}>←</button>
            <button type="button" aria-label="Next Discover card" onClick={() => changeCard(1)}>→</button>
          </div>
        </div>
      </article>
    </section>
  );
}

type WatchState = 'idle' | 'loading' | 'navigated' | 'verified' | 'unverified' | 'error';

function configuredWidgetUrl(): string | null {
  const raw = import.meta.env.VITE_EXPLORE_WIDGET_URL?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

function WatchView(): JSX.Element {
  const widgetUrl = configuredWidgetUrl();
  const [state, setState] = useState<WatchState>('idle');
  const [loadKey, setLoadKey] = useState(0);
  const timeoutRef = useRef<number | null>(null);
  const frameRef = useRef<HTMLIFrameElement | null>(null);

  const clearLoadTimeout = (): void => {
    if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current);
    timeoutRef.current = null;
  };

  useEffect(() => clearLoadTimeout, []);

  useEffect(() => {
    if (!widgetUrl) return undefined;
    const expectedOrigin = new URL(widgetUrl).origin;
    const onMessage = (event: MessageEvent): void => {
      if (
        event.origin !== expectedOrigin ||
        event.source !== frameRef.current?.contentWindow ||
        typeof event.data !== 'object' ||
        event.data === null ||
        (event.data as { type?: unknown }).type !== 'weft:explore-ready'
      ) {
        return;
      }
      clearLoadTimeout();
      setState('verified');
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [widgetUrl]);

  const load = (): void => {
    if (!widgetUrl || (typeof navigator !== 'undefined' && navigator.onLine === false)) {
      setState('error');
      return;
    }
    clearLoadTimeout();
    setLoadKey((value) => value + 1);
    setState('loading');
    timeoutRef.current = window.setTimeout(() => setState('unverified'), 12_000);
  };

  if (!widgetUrl) {
    return (
      <section className="watch-empty">
        <span className="explore-large-icon" aria-hidden="true"><PlayGlyph /></span>
        <h1>Watch is ready for a provider</h1>
        <p>
          Configure <code>VITE_EXPLORE_WIDGET_URL</code> with the HTTPS URL of the isolated
          auto-updating video widget. No Weft session data is sent to it.
        </p>
      </section>
    );
  }

  return (
    <section className="watch-view">
      {state === 'idle' ? (
        <div className="watch-consent">
          <span className="explore-large-icon" aria-hidden="true"><PlayGlyph /></span>
          <h1>External short videos</h1>
          <p>
            This feed is provided by a third party. Opening it contacts that provider under its own
            privacy policy. Weft does not send prompts, session details, repositories, or agent activity.
          </p>
          <button type="button" className="explore-primary" onClick={load}>Load video feed</button>
        </div>
      ) : null}
      {state === 'loading' || state === 'navigated' || state === 'verified' || state === 'unverified' ? (
        <div className={`watch-frame-shell ${state}`}>
          {state === 'loading' ? <p role="status">Loading the external video feed…</p> : null}
          {state === 'navigated' ? (
            <p role="status">Provider navigation completed. Display readiness cannot be verified yet.</p>
          ) : null}
          {state === 'verified' ? <p role="status">The provider reported that its content is ready.</p> : null}
          <iframe
            key={loadKey}
            ref={frameRef}
            title="External short video feed"
            src={widgetUrl}
            sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-presentation"
            allow="fullscreen; picture-in-picture; encrypted-media"
            referrerPolicy="no-referrer"
            onLoad={() => {
              setState((current) => current === 'loading' ? 'navigated' : current);
            }}
          />
          {state === 'unverified' ? (
            <div className="watch-verification" role="alert">
              <strong>Weft could not verify the embedded display.</strong>
              <span>
                Cross-origin providers cannot be inspected. If the area is blank, the provider may
                block embedding with browser security policy.
              </span>
            </div>
          ) : null}
          {state !== 'loading' ? (
            <div className="watch-controls">
              <a className="explore-secondary" href={widgetUrl} target="_blank" rel="noreferrer">
                Open provider directly
              </a>
              <button type="button" className="explore-secondary" onClick={load}>Reload</button>
              <button
                type="button"
                className="explore-secondary"
                onClick={() => {
                  clearLoadTimeout();
                  setState('idle');
                }}
              >
                Hide feed
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
      {state === 'error' ? (
        <div className="watch-empty" role="alert">
          <h1>Video feed unavailable</h1>
          <p>Check your connection, then retry or open the configured provider directly.</p>
          <a className="explore-secondary" href={widgetUrl} target="_blank" rel="noreferrer">
            Open provider directly
          </a>
          <button type="button" className="explore-secondary" onClick={load}>Retry</button>
        </div>
      ) : null}
    </section>
  );
}

interface Point {
  id: number;
  x: number;
  y: number;
}

const THREAD_EDGES: Array<[number, number]> = [
  [0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 0], [0, 2], [2, 4], [4, 0],
];
type PlayMode = 'daily' | 'free';

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = Math.imul(state ^ (state >>> 15), 1 | state);
    state ^= state + Math.imul(state ^ (state >>> 7), 61 | state);
    return ((state ^ (state >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export function createSignalSequence(seed: number, length = 32): number[] {
  const random = seededRandom(seed);
  return Array.from({ length }, () => Math.floor(random() * 9));
}

function dailySeed(offset = 0): number {
  const date = new Date();
  return Number(`${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, '0')}${String(date.getUTCDate()).padStart(2, '0')}`) + offset;
}

export function createThreadlinePoints(seed: number): Point[] {
  const random = seededRandom(seed);
  for (let attempt = 0; attempt < 24; attempt += 1) {
    const points = Array.from({ length: 6 }, (_, id) => ({
      id,
      x: 18 + random() * 64,
      y: 18 + random() * 64,
    }));
    if (countThreadlineCrossings(points) > 0) return points;
  }
  return [
    { id: 0, x: 20, y: 20 },
    { id: 1, x: 80, y: 80 },
    { id: 2, x: 80, y: 20 },
    { id: 3, x: 20, y: 80 },
    { id: 4, x: 50, y: 12 },
    { id: 5, x: 50, y: 88 },
  ];
}

const GEOMETRY_EPSILON = 1e-7;

function orientation(a: Point, b: Point, c: Point): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function samePoint(a: Point, b: Point): boolean {
  return Math.abs(a.x - b.x) <= GEOMETRY_EPSILON && Math.abs(a.y - b.y) <= GEOMETRY_EPSILON;
}

function pointOnSegment(point: Point, a: Point, b: Point): boolean {
  if (Math.abs(orientation(a, b, point)) > GEOMETRY_EPSILON) return false;
  return (
    point.x >= Math.min(a.x, b.x) - GEOMETRY_EPSILON &&
    point.x <= Math.max(a.x, b.x) + GEOMETRY_EPSILON &&
    point.y >= Math.min(a.y, b.y) - GEOMETRY_EPSILON &&
    point.y <= Math.max(a.y, b.y) + GEOMETRY_EPSILON
  );
}

function orientationSign(value: number): -1 | 0 | 1 {
  if (Math.abs(value) <= GEOMETRY_EPSILON) return 0;
  return value < 0 ? -1 : 1;
}

function segmentsIntersectInclusive(a: Point, b: Point, c: Point, d: Point): boolean {
  const o1 = orientationSign(orientation(a, b, c));
  const o2 = orientationSign(orientation(a, b, d));
  const o3 = orientationSign(orientation(c, d, a));
  const o4 = orientationSign(orientation(c, d, b));

  if (o1 * o2 < 0 && o3 * o4 < 0) return true;
  return (
    (o1 === 0 && pointOnSegment(c, a, b)) ||
    (o2 === 0 && pointOnSegment(d, a, b)) ||
    (o3 === 0 && pointOnSegment(a, c, d)) ||
    (o4 === 0 && pointOnSegment(b, c, d))
  );
}

export function countThreadlineCrossings(points: Point[]): number {
  let conflicts = 0;

  for (let i = 0; i < points.length; i += 1) {
    const first = points[i];
    if (!first) continue;
    for (let j = i + 1; j < points.length; j += 1) {
      const second = points[j];
      if (second && samePoint(first, second)) conflicts += 1;
    }
  }

  for (const [from, to] of THREAD_EDGES) {
    const a = points[from];
    const b = points[to];
    if (!a || !b) continue;
    for (const point of points) {
      if (point.id === from || point.id === to) continue;
      if (pointOnSegment(point, a, b)) conflicts += 1;
    }
  }

  for (let i = 0; i < THREAD_EDGES.length; i += 1) {
    const first = THREAD_EDGES[i];
    if (!first) continue;
    for (let j = i + 1; j < THREAD_EDGES.length; j += 1) {
      const second = THREAD_EDGES[j];
      if (!second || first.some((node) => second.includes(node))) continue;
      const [a, b] = first.map((id) => points[id]);
      const [c, d] = second.map((id) => points[id]);
      if (a && b && c && d && segmentsIntersectInclusive(a, b, c, d)) conflicts += 1;
    }
  }
  return conflicts;
}

function PlayView({
  stored,
  onChange,
}: {
  stored: Required<ExploreStoredState>;
  onChange(next: Required<ExploreStoredState>): void;
}): JSX.Element {
  const [game, setGame] = useState<'threadline' | 'signal' | null>(null);
  const [mode, setMode] = useState<PlayMode>('daily');
  if (game === 'threadline') {
    return <ThreadlineGame mode={mode} stored={stored} onChange={onChange} onBack={() => setGame(null)} />;
  }
  if (game === 'signal') {
    return <SignalSteps mode={mode} stored={stored} onChange={onChange} onBack={() => setGame(null)} />;
  }
  return (
    <section className="activity-picker">
      <div className="duration-row" role="group" aria-label="Play mode">
        <button type="button" className={mode === 'daily' ? 'active' : ''} onClick={() => setMode('daily')}>
          Daily
        </button>
        <button type="button" className={mode === 'free' ? 'active' : ''} onClick={() => setMode('free')}>
          Free play
        </button>
      </div>
      <button type="button" className="activity-card" onClick={() => setGame('threadline')}>
        <span className="activity-preview thread-preview" aria-hidden="true">╲╱</span>
        <span><small>Logic · 1–3 min</small><strong>Threadline</strong><p>Move the points until no threads cross.</p></span>
        <b>{stored.threadlineCompleted} solved</b>
      </button>
      <button type="button" className="activity-card" onClick={() => setGame('signal')}>
        <span className="activity-preview signal-preview" aria-hidden="true">● ○ ●</span>
        <span><small>Memory · 30 sec+</small><strong>Signal Steps</strong><p>Watch a sequence, then repeat it.</p></span>
        <b>Best {stored.signalBest}</b>
      </button>
    </section>
  );
}

function ThreadlineGame({
  mode,
  stored,
  onChange,
  onBack,
}: {
  mode: PlayMode;
  stored: Required<ExploreStoredState>;
  onChange(next: Required<ExploreStoredState>): void;
  onBack(): void;
}): JSX.Element {
  const [seed, setSeed] = useState(() =>
    mode === 'daily' ? dailySeed() : dailySeed(1_000 + stored.threadlineCompleted),
  );
  const [points, setPoints] = useState<Point[]>(() => createThreadlinePoints(seed));
  const [dragging, setDragging] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const crossings = countThreadlineCrossings(points);
  const completedRef = useRef(false);

  useEffect(() => {
    if (crossings !== 0 || completedRef.current) return;
    completedRef.current = true;
    onChange({ ...stored, threadlineCompleted: stored.threadlineCompleted + 1 });
    if (stored.vibration) navigator.vibrate?.(18);
  }, [crossings, onChange, stored]);

  const movePoint = (id: number, x: number, y: number): void => {
    setPoints((current) =>
      current.map((point) =>
        point.id === id
          ? { ...point, x: Math.max(6, Math.min(94, x)), y: Math.max(6, Math.min(94, y)) }
          : point,
      ),
    );
  };

  const pointerPosition = (event: ReactPointerEvent<SVGSVGElement>): { x: number; y: number } => {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) / rect.width) * 100,
      y: ((event.clientY - rect.top) / rect.height) * 100,
    };
  };

  const reset = (): void => {
    const nextSeed = mode === 'daily' ? dailySeed() : seed + 1;
    setSeed(nextSeed);
    completedRef.current = false;
    setPoints(createThreadlinePoints(nextSeed));
  };

  return (
    <section className="game-view">
      <button type="button" className="explore-text-back" onClick={onBack}>‹ Play</button>
      <div className="game-heading">
        <p className="explore-kicker">Threadline · {mode === 'daily' ? 'Daily' : 'Free play'}</p>
        <h1>{crossings === 0 ? 'Untangled' : `${crossings} crossing${crossings === 1 ? '' : 's'} left`}</h1>
        <p>Drag the points. Connected lines may meet at a point, but no other threads should cross.</p>
      </div>
      <svg
        ref={svgRef}
        className={`threadline-board${crossings === 0 ? ' complete' : ''}`}
        viewBox="0 0 100 100"
        role="group"
        aria-label={`Threadline puzzle with ${crossings} crossings remaining`}
        onPointerMove={(event) => {
          if (dragging == null) return;
          const position = pointerPosition(event);
          movePoint(dragging, position.x, position.y);
        }}
        onPointerUp={() => setDragging(null)}
        onPointerCancel={() => setDragging(null)}
      >
        {THREAD_EDGES.map(([from, to]) => {
          const a = points[from];
          const b = points[to];
          return a && b ? <line key={`${from}-${to}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} /> : null;
        })}
        {points.map((point) => (
          <g
            key={point.id}
            role="button"
            tabIndex={0}
            aria-label={`Move point ${point.id + 1}`}
            transform={`translate(${point.x} ${point.y})`}
            onPointerDown={(event) => {
              event.currentTarget.setPointerCapture(event.pointerId);
              setDragging(point.id);
            }}
            onKeyDown={(event: ReactKeyboardEvent<SVGGElement>) => {
              const step = event.shiftKey ? 5 : 2;
              const delta =
                event.key === 'ArrowLeft' ? [-step, 0] :
                event.key === 'ArrowRight' ? [step, 0] :
                event.key === 'ArrowUp' ? [0, -step] :
                event.key === 'ArrowDown' ? [0, step] : null;
              if (!delta) return;
              event.preventDefault();
              movePoint(point.id, point.x + delta[0], point.y + delta[1]);
            }}
          >
            <circle r="5" />
            <text textAnchor="middle" dominantBaseline="central">{point.id + 1}</text>
          </g>
        ))}
      </svg>
      <div className="game-actions">
        <button type="button" className="explore-secondary" onClick={reset}>
          {mode === 'daily' ? 'Reset daily puzzle' : 'New puzzle'}
        </button>
      </div>
    </section>
  );
}

type SignalPhase = 'idle' | 'showing' | 'input' | 'success' | 'error';

function SignalSteps({
  mode,
  stored,
  onChange,
  onBack,
}: {
  mode: PlayMode;
  stored: Required<ExploreStoredState>;
  onChange(next: Required<ExploreStoredState>): void;
  onBack(): void;
}): JSX.Element {
  const sequence = useMemo(
    () =>
      createSignalSequence(
        mode === 'daily' ? dailySeed(91) : dailySeed(10_000 + stored.signalBest),
      ),
    [mode, stored.signalBest],
  );
  const [round, setRound] = useState(3);
  const [phase, setPhase] = useState<SignalPhase>('idle');
  const [lit, setLit] = useState<number | null>(null);
  const [input, setInput] = useState<number[]>([]);
  const timers = useRef<number[]>([]);

  const clearTimers = useCallback((): void => {
    for (const timer of timers.current) window.clearTimeout(timer);
    timers.current = [];
  }, []);

  useEffect(() => clearTimers, [clearTimers]);

  const showSequence = useCallback((): void => {
    clearTimers();
    setInput([]);
    setPhase('showing');
    sequence.slice(0, round).forEach((cell, index) => {
      timers.current.push(window.setTimeout(() => setLit(cell), index * 650 + 250));
      timers.current.push(window.setTimeout(() => setLit(null), index * 650 + 620));
    });
    timers.current.push(window.setTimeout(() => setPhase('input'), round * 650 + 700));
  }, [clearTimers, round, sequence]);

  const choose = (cell: number): void => {
    if (phase !== 'input') return;
    const next = [...input, cell];
    const expected = sequence[next.length - 1];
    if (cell !== expected) {
      setPhase('error');
      setInput([]);
      if (stored.vibration) navigator.vibrate?.([20, 40, 20]);
      return;
    }
    setInput(next);
    if (next.length === round) {
      const best = Math.max(stored.signalBest, round);
      onChange({ ...stored, signalBest: best });
      setPhase('success');
      if (stored.vibration) navigator.vibrate?.(18);
      timers.current.push(window.setTimeout(() => {
        setRound((value) => value + 1);
        setPhase('idle');
        setInput([]);
      }, 700));
    }
  };

  return (
    <section className="game-view">
      <button type="button" className="explore-text-back" onClick={onBack}>‹ Play</button>
      <div className="game-heading">
        <p className="explore-kicker">Signal Steps · {mode === 'daily' ? 'Daily' : 'Free play'}</p>
        <h1>Round {round - 2}</h1>
        <p>
          {phase === 'showing' ? 'Watch the sequence.' :
            phase === 'input' ? `Repeat it: ${input.length} of ${round}` :
            phase === 'success' ? 'Correct.' :
            phase === 'error' ? 'That was not the sequence. Try again.' :
            'Start when you are ready.'}
        </p>
      </div>
      <div className="signal-grid" role="group" aria-label="Signal Steps grid">
        {Array.from({ length: 9 }, (_, cell) => (
          <button
            type="button"
            key={cell}
            className={lit === cell ? 'lit' : input.at(-1) === cell && phase === 'input' ? 'pressed' : ''}
            aria-label={`Signal tile ${cell + 1}`}
            disabled={phase !== 'input'}
            onClick={() => choose(cell)}
          />
        ))}
      </div>
      <div className="game-actions">
        <button
          type="button"
          className="explore-primary"
          disabled={phase === 'showing' || phase === 'input' || phase === 'success'}
          onClick={showSequence}
        >
          {phase === 'error' ? 'Try again' : 'Show sequence'}
        </button>
        <span>Best sequence: {stored.signalBest}</span>
      </div>
    </section>
  );
}

function UnwindView({
  stored,
  onChange,
}: {
  stored: Required<ExploreStoredState>;
  onChange(next: Required<ExploreStoredState>): void;
}): JSX.Element {
  const [activity, setActivity] = useState<'breathe' | 'eyes' | null>(null);
  if (activity === 'breathe') {
    return <WeaveBreath stored={stored} onChange={onChange} onBack={() => setActivity(null)} />;
  }
  if (activity === 'eyes') {
    return <EyeHorizon stored={stored} onBack={() => setActivity(null)} />;
  }
  return (
    <section className="activity-picker">
      <button type="button" className="activity-card" onClick={() => setActivity('breathe')}>
        <span className="activity-preview breathe-preview" aria-hidden="true"><WaveGlyph /></span>
        <span><small>1, 2, or 5 min</small><strong>Weave Breath</strong><p>A quiet guided breathing rhythm.</p></span>
      </button>
      <button type="button" className="activity-card" onClick={() => setActivity('eyes')}>
        <span className="activity-preview horizon-preview" aria-hidden="true">— ◯ —</span>
        <span><small>20 seconds</small><strong>Eye Horizon</strong><p>Look away and let your eyes reset.</p></span>
      </button>
      <label className="explore-toggle">
        <input
          type="checkbox"
          checked={stored.vibration}
          onChange={(event) => onChange({ ...stored, vibration: event.target.checked })}
        />
        <span>Use gentle completion vibration</span>
      </label>
    </section>
  );
}

function useDeadlineTimer(initialSeconds: number, onComplete: () => void): {
  remaining: number;
  running: boolean;
  start(seconds?: number): void;
  pause(): void;
  reset(seconds?: number): void;
} {
  const [remaining, setRemaining] = useState(initialSeconds);
  const [running, setRunning] = useState(false);
  const deadlineRef = useRef<number | null>(null);
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  const sync = useCallback((): void => {
    const deadline = deadlineRef.current;
    if (deadline === null) return;
    const next = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    setRemaining(next);
    if (next === 0) {
      deadlineRef.current = null;
      setRunning(false);
      onCompleteRef.current();
    }
  }, []);

  useEffect(() => {
    if (!running) return undefined;
    sync();
    const timer = window.setInterval(sync, 1000);
    document.addEventListener('visibilitychange', sync);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', sync);
    };
  }, [running, sync]);

  const start = useCallback((seconds?: number): void => {
    const next = seconds ?? (remaining > 0 ? remaining : initialSeconds);
    setRemaining(next);
    deadlineRef.current = Date.now() + next * 1000;
    setRunning(true);
  }, [initialSeconds, remaining]);

  const pause = useCallback((): void => {
    sync();
    deadlineRef.current = null;
    setRunning(false);
  }, [sync]);

  const reset = useCallback((seconds = initialSeconds): void => {
    deadlineRef.current = null;
    setRunning(false);
    setRemaining(seconds);
  }, [initialSeconds]);

  return { remaining, running, start, pause, reset };
}

function WeaveBreath({
  stored,
  onChange,
  onBack,
}: {
  stored: Required<ExploreStoredState>;
  onChange(next: Required<ExploreStoredState>): void;
  onBack(): void;
}): JSX.Element {
  const [duration, setDuration] = useState(60);
  const [completed, setCompleted] = useState(false);
  const timer = useDeadlineTimer(duration, () => {
    setCompleted(true);
    if (stored.vibration) navigator.vibrate?.(20);
  });
  const { remaining, running } = timer;

  const elapsed = duration - remaining;
  const phaseOffset = elapsed % 12;
  const phase = phaseOffset < 4 ? 'Inhale' : phaseOffset < 6 ? 'Hold' : 'Exhale';
  const phaseClass = phase.toLowerCase();

  const selectDuration = (seconds: number): void => {
    setDuration(seconds);
    timer.reset(seconds);
    setCompleted(false);
  };

  return (
    <section className="unwind-session">
      <button type="button" className="explore-text-back" onClick={onBack}>‹ Unwind</button>
      <p className="explore-kicker">Weave Breath</p>
      <h1>{completed ? 'Complete' : running ? phase : 'Choose a pace'}</h1>
      <div className={`weave-breath-visual ${phaseClass}${running ? ' running' : ''}`} aria-hidden="true">
        <span /><span /><span />
      </div>
      <p className="unwind-time" aria-live="polite">{Math.floor(remaining / 60)}:{String(remaining % 60).padStart(2, '0')}</p>
      <div className="duration-row" role="group" aria-label="Breathing duration">
        {[60, 120, 300].map((seconds) => (
          <button type="button" key={seconds} className={duration === seconds ? 'active' : ''} onClick={() => selectDuration(seconds)}>
            {seconds / 60} min
          </button>
        ))}
      </div>
      <div className="game-actions">
        <button type="button" className="explore-primary" onClick={() => {
          if (running) {
            timer.pause();
            return;
          }
          if (completed || remaining === 0) {
            setCompleted(false);
            timer.start(duration);
            return;
          }
          timer.start();
        }}>
          {running ? 'Pause' : completed ? 'Again' : 'Begin'}
        </button>
      </div>
      <label className="explore-toggle">
        <input
          type="checkbox"
          checked={stored.vibration}
          onChange={(event) => onChange({ ...stored, vibration: event.target.checked })}
        />
        <span>Use gentle completion vibration</span>
      </label>
    </section>
  );
}

function EyeHorizon({
  stored,
  onBack,
}: {
  stored: Required<ExploreStoredState>;
  onBack(): void;
}): JSX.Element {
  const timer = useDeadlineTimer(20, () => {
    if (stored.vibration) navigator.vibrate?.(20);
  });
  const { remaining, running } = timer;

  const start = (): void => {
    timer.start(remaining === 0 ? 20 : undefined);
  };

  return (
    <section className="unwind-session eye-horizon">
      <button type="button" className="explore-text-back" onClick={onBack}>‹ Unwind</button>
      <p className="explore-kicker">Eye Horizon</p>
      <h1>{remaining === 0 ? 'Welcome back' : 'Look at something far away'}</h1>
      <div className="horizon-visual" aria-hidden="true"><span /></div>
      <p className="unwind-time" aria-live="polite">{remaining}s</p>
      <p>Relax your shoulders, blink normally, and let your focus move beyond the screen.</p>
      <button type="button" className="explore-primary" disabled={running} onClick={start}>
        {remaining === 0 ? 'Again' : running ? 'Resting…' : 'Start 20 seconds'}
      </button>
    </section>
  );
}
