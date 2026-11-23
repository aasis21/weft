import { Fragment, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { WeftMenuTile } from '@/ui/brand/WeftMark';
import type { JSX, KeyboardEvent, ReactNode } from 'react';
import { sessionRuntime } from '@/session/runtime/instance';
import type { SessionStatus } from '@/session/model';
import { debugModeMirror, isDebugModeEnabled } from '@/lib/debugSettings';
import { deriveStatus, type ComposerActivity } from './sessionStatus';
import { FolderGlyph, ChangesGlyph } from '@/ui/workspace/fileGlyphs';
import { ChatSwitcher, noteChatVisit, useTitleGestures } from './chatSwitcher';

/** One line-icon style for every ⋯ menu item: 24-unit grid, 1.7 stroke, current colour. */
function MenuGlyph({ children }: { children: ReactNode }): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      {children}
    </svg>
  );
}

/** Viewfinder-with-QR mark: opens the camera to scan a pairing code. */
function ScanGlyph(): JSX.Element {
  return (
    <MenuGlyph>
      <path d="M4 8V6a2 2 0 0 1 2-2h2" />
      <path d="M16 4h2a2 2 0 0 1 2 2v2" />
      <path d="M20 16v2a2 2 0 0 1-2 2h-2" />
      <path d="M8 20H6a2 2 0 0 1-2-2v-2" />
      <rect x="9" y="9" width="6" height="6" rx="1" />
    </MenuGlyph>
  );
}

function RenameGlyph(): JSX.Element {
  return <MenuGlyph><path d="M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17v3Z" /><path d="m14 7 3 3" /></MenuGlyph>;
}

function PinGlyph(): JSX.Element {
  return <MenuGlyph><path d="M9 4h6l-1 6 3 3H7l3-3-1-6Z" /><path d="M12 13v7" /></MenuGlyph>;
}

function ArchiveGlyph(): JSX.Element {
  return <MenuGlyph><rect x="3" y="4" width="18" height="4" rx="1" /><path d="M5 8v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8" /><path d="M10 12h4" /></MenuGlyph>;
}

function DebugGlyph(): JSX.Element {
  return <MenuGlyph><path d="M8 4H7a2 2 0 0 0-2 2v4l-2 2 2 2v4a2 2 0 0 0 2 2h1" /><path d="M16 4h1a2 2 0 0 1 2 2v4l2 2-2 2v4a2 2 0 0 1-2 2h-1" /></MenuGlyph>;
}

function RemoveGlyph(): JSX.Element {
  return <MenuGlyph><path d="M4 7h16" /><path d="M10 11v6M14 11v6" /><path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12" /><path d="M9 7V4h6v3" /></MenuGlyph>;
}

function CompassGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="8.5" />
      <path d="m14.8 9.2-1.7 3.9-3.9 1.7 1.7-3.9 3.9-1.7Z" />
    </svg>
  );
}

interface StatusBarProps {
  onOpenFiles?(): void;
  onOpenChanges?(): void;
  title: string;
  cwd: string | null;
  status: SessionStatus;
  /** True while the agent is actively working (busy). Overrides the "Live" label with "Working…". */
  busy?: boolean;
  /** What the composer is doing — outranks `busy` so the pill mirrors the mic/speech (#184). */
  activity?: ComposerActivity;
  onOpenDrawer(): void;
  /** Open the permanent Explore destination. Independent from the read-only session status line. */
  onOpenExplore?(): void;
  /** Scan a QR to connect another session (the ⋯ menu's "Scan QR to connect"). */
  onAddSession(): void;
  onStartSession?(): void;
  /** #163: archive this session now (drop the live socket, keep the card). Shown only when live. */
  onArchive?(): void;
  /** Rename this session (shown in the "⋯" menu; opens an inline title editor in the header). */
  onRename?(title: string): void;
  /** Pin/unpin this session (exempt from auto-delete + eviction preference). */
  onPin?(pinned: boolean): void;
  pinned?: boolean;
  /** #163: demo sessions can't archive — hide that item. */
  isDemo?: boolean;
  /** "Remove from this phone"; the caller confirms first (the session keeps running on the laptop). */
  onRemove(): void;
  onGoHome(): void;
  onOpenDebug(): void;
  /** Desktop (#183): the session list is already docked and always visible, so the
   *  hamburger that opens it would be redundant (and confusing — nothing "opens").
   *  Show a static Weft mark instead, linking to About Weft like a typical app logo. */
  desktopDocked?: boolean;
  /** Switch to another chat from the title gestures (swipe, long-press card, double-tap). */
  onSwitchSession?(channelId: string): void;
}

/** Last path segment, for showing a session's folder compactly. */
function folderName(path: string | null): string | null {
  if (!path) return null;
  const parts = path.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** The header names the session (its name, else its folder) and never shows the brand as a title. */
function sessionTitle(title: string, cwd: string | null): string {
  const name = title.trim();
  if (name && name.toLowerCase() !== 'weft') return name;
  return folderName(cwd) ?? 'Session';
}

export function StatusBar({
  title,
  cwd,
  status,
  busy = false,
  activity,
  onOpenDrawer,
  onOpenExplore,
  onAddSession,
  onStartSession,
  onArchive,
  onRename,
  onPin,
  pinned = false,
  isDemo = false,
  onRemove,
  onGoHome,
  onOpenDebug,
  desktopDocked = false,
  onOpenFiles,
  onOpenChanges,
  onSwitchSession,
}: StatusBarProps): JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false);
  /** "Debug events" is a developer tool: listed only while Debug mode is on (Settings). */
  const [debugMode, setDebugMode] = useState(debugModeMirror);
  const debugModeRef = useRef(debugMode);
  debugModeRef.current = debugMode;
  const [renaming, setRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState(title);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const menuButtonRef = useRef<HTMLButtonElement | null>(null);
  const snapshot = useSyncExternalStore(sessionRuntime.subscribe, sessionRuntime.getSnapshot);
  const unreadCount = snapshot.sessions.filter((session) => session.unread && session.meta.channelId !== snapshot.activeId).length;
  // Another session is waiting for an approval or a form answer. Only this specific, actionable
  // state gets a mark on the menu button (an unread rollup badge was removed as ambiguous, #161).
  const othersAwaitingDecision = snapshot.sessions.filter((session) =>
    session.meta.channelId !== snapshot.activeId && (session.needsAttention ?? 0) > 0).length;
  const drawerLabel = othersAwaitingDecision > 0
    ? `Open sessions, ${othersAwaitingDecision} waiting for your decision`
    : unreadCount > 0 ? `Open sessions, ${unreadCount} unread` : 'Open sessions';
  const activeSession = snapshot.sessions.find((session) => session.meta.channelId === snapshot.activeId);
  // Single source of truth for the pill (#163): the same derivation the sidebar rows use, so the
  // header can never read "Live" while a row (or the banner below) says otherwise. Splits the calm
  // "Archived" (cold, tap to reconnect) from the problem "Offline" (error, reconnect).
  const derived = deriveStatus(
    { status, cold: activeSession?.cold ?? false, error: activeSession?.error },
    { busy, ...(activity ? { activity } : {}) },
  );
  const lineClass = derived.tone;
  const statusIdRef = useRef<HTMLDivElement | null>(null);
  const gestures = useTitleGestures({
    enabled: !renaming,
    sessions: snapshot.sessions,
    activeId: snapshot.activeId,
    ...(onSwitchSession ? { onSwitch: onSwitchSession } : {}),
  });
  useEffect(() => {
    if (snapshot.activeId) noteChatVisit(snapshot.activeId);
  }, [snapshot.activeId]);
  const statusLabel = derived.label;

  const beginRename = (): void => {
    setRenameDraft(title);
    setRenaming(true);
  };
  const commitRename = (): void => {
    const trimmed = renameDraft.trim();
    if (trimmed && trimmed !== title) onRename?.(trimmed);
    setRenaming(false);
  };
  const cancelRename = (): void => setRenaming(false);

  useEffect(() => {
    let live = true;
    void isDebugModeEnabled().then((enabled) => {
      if (live && enabled !== debugModeRef.current) setDebugMode(enabled);
    });
    return () => {
      live = false;
    };
  }, [menuOpen]);

  useEffect(() => {
    if (!menuOpen) return undefined;
    const onDoc = (e: MouseEvent): void => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key === 'Escape') {
        setMenuOpen(false);
        menuButtonRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  const focusMenuItem = (direction: 1 | -1): void => {
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);
    if (!items.length) return;
    const index = items.findIndex((el) => el === document.activeElement);
    items[(index + direction + items.length) % items.length]?.focus();
  };

  const onMenuButtonKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    setMenuOpen(true);
    window.requestAnimationFrame(() => focusMenuItem(event.key === 'ArrowDown' ? 1 : -1));
  };

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      focusMenuItem(event.key === 'ArrowDown' ? 1 : -1);
    }
  };

  const menuItem = (label: string, glyph: JSX.Element, onSelect: () => void, danger = false): JSX.Element => (
    <button
      key={label}
      type="button"
      role="menuitem"
      className={`bar-menu-item bar-menu-item-with-icon${danger ? ' danger' : ''}`}
      onClick={() => {
        setMenuOpen(false);
        onSelect();
      }}
    >
      {glyph}
      <span>{label}</span>
    </button>
  );
  // Groups, divided: workspace · this session · connect · developer · destructive.
  const menuGroups = [
    [
      onOpenFiles ? menuItem('Files', <FolderGlyph />, onOpenFiles) : null,
      onOpenChanges ? menuItem('Changes', <ChangesGlyph />, onOpenChanges) : null,
    ],
    [
      onRename ? menuItem('Rename', <RenameGlyph />, beginRename) : null,
      onPin ? menuItem(pinned ? 'Unpin' : 'Pin to top', <PinGlyph />, () => onPin(!pinned)) : null,
      derived.active && !isDemo && onArchive ? menuItem('Archive', <ArchiveGlyph />, onArchive) : null,
    ],
    [menuItem('Scan QR to connect', <ScanGlyph />, onAddSession)],
    [debugMode ? menuItem('Debug events', <DebugGlyph />, onOpenDebug) : null],
    [menuItem('Remove from this phone', <RemoveGlyph />, onRemove, true)],
  ].map((group) => group.filter((item): item is JSX.Element => item !== null))
    .filter((group) => group.length > 0);

  return (
    <header className="status-bar">
      {desktopDocked ? (
        <button
          className="icon-btn weft-mark-btn"
          type="button"
          onClick={onGoHome}
          title="About Weft"
          aria-label="About Weft"
        >
          <WeftMenuTile />
        </button>
      ) : (
        <button
          className="icon-btn drawer-btn"
          type="button"
          onClick={onOpenDrawer}
          aria-label={drawerLabel}
        >
          <WeftMenuTile dot={othersAwaitingDecision > 0} />
        </button>
      )}

      <div
        ref={statusIdRef}
        className={`status-id${onSwitchSession && !renaming ? ' switchable' : ''}`}
        {...(onSwitchSession && !renaming ? gestures.handlers : {})}
      >
        <div
          key={snapshot.activeId ?? 'none'}
          className={`status-track${gestures.dragX ? ' dragging' : ''}${gestures.enter ? ` enter-${gestures.enter}` : ''}`}
          style={gestures.dragX ? { transform: `translateX(${gestures.dragX}px)` } : undefined}
          onAnimationEnd={(e) => { if (e.target === e.currentTarget) gestures.clearEnter(); }}
        >
          {renaming ? (
            <input
              className="status-rename-input"
              type="text"
              value={renameDraft}
              autoFocus
              aria-label="Rename session"
              onChange={(e) => setRenameDraft(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Enter') commitRename();
                if (e.key === 'Escape') cancelRename();
              }}
              onBlur={commitRename}
            />
          ) : (
            <span className="status-title" title={cwd ?? undefined}>
              {pinned ? <span className="pin-mark" title="Pinned" aria-label="Pinned">📌</span> : null}
              {sessionTitle(title, cwd)}
            </span>
          )}
          <span className={`status-line ${lineClass}`}>
            <span className="status-dot" aria-hidden="true" />
            {statusLabel}
            {folderName(cwd) ? <span className="status-folder" title={cwd ?? undefined}> · {folderName(cwd)}</span> : null}
          </span>
          {gestures.peek ? (
            <span className={`status-peek ${gestures.dragX < 0 ? 'next' : 'prev'}`} aria-hidden="true">
              {gestures.peek.meta.title}
            </span>
          ) : null}
        </div>
      </div>
      {gestures.switcherOpen ? (
        <ChatSwitcher
          choices={gestures.choices}
          devices={snapshot.devices}
          highlightId={gestures.highlightId}
          anchor={statusIdRef.current?.closest('header') ?? null}
          onPick={gestures.pick}
          onAllChats={onOpenDrawer}
          onClose={gestures.closeSwitcher}
        />
      ) : null}

      <div className="status-icons">
        {onOpenExplore ? (
          <button
            className="icon-btn explore-btn"
            type="button"
            onClick={onOpenExplore}
            aria-label="Open Explore"
            title="Explore"
          >
            <CompassGlyph />
          </button>
        ) : null}

        <button
          className="icon-btn start-btn"
          type="button"
          onClick={onStartSession}
          aria-label="Start another session"
          title="Start another session"
        >
          ＋
        </button>

        <div className="bar-menu-wrap" ref={menuRef}>
          <button
            className="icon-btn menu-btn"
            type="button"
            ref={menuButtonRef}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((v) => !v)}
            onKeyDown={onMenuButtonKeyDown}
            aria-label="Session menu"
          >
            ⋯
          </button>
          {menuOpen ? (
            <div className="bar-menu" role="menu" onKeyDown={onMenuKeyDown}>
              {menuGroups.map((group, index) => (
                <Fragment key={index}>
                  {index > 0 ? <div className="bar-menu-sep" role="separator" /> : null}
                  {group}
                </Fragment>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </header>
  );
}
