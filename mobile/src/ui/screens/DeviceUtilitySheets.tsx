import { useEffect, useId, useLayoutEffect, useRef, useState, type JSX, type ReactNode } from 'react';
import { App as CapacitorApp } from '@capacitor/app';
import {
  CLIPBOARD_MAX_BYTES,
  KEEP_AWAKE_MIN_MS,
  KEEP_AWAKE_MAX_MS,
  clipboardTextError,
  type DeviceUtilityCode,
  type KeepAwakeStatusMsg,
} from '@aasis21/weft-shared';
import type { ListenerDeviceState } from '@/session/model';
import { useNowTick } from '@/ui/hooks/useNowTick';

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const UTILITY_ERRORS: Record<Exclude<DeviceUtilityCode, 'ok'>, string> = {
  'invalid-request': 'This request could not be accepted. Check your input and try again.',
  'too-large': `Text exceeds ${CLIPBOARD_MAX_BYTES / 1024} KiB of UTF-8. Shorten it and try again.`,
  unsupported: 'Update Weft on this laptop to use this utility.',
  unavailable: 'Unavailable on this laptop. Try again or restart Device Station.',
  timeout: 'The laptop did not respond in time. Check its connection and try again.',
  'lease-mismatch': 'Keep Awake changed on the laptop. Close and reopen this sheet to refresh its status.',
};

function utilityError(code: DeviceUtilityCode | undefined): string | null {
  if (!code || code === 'ok') return null;
  return Object.prototype.hasOwnProperty.call(UTILITY_ERRORS, code)
    ? UTILITY_ERRORS[code as Exclude<DeviceUtilityCode, 'ok'>]
    : 'The operation failed. Close and reopen this sheet, then try again.';
}

export function keepAwakeRemaining(status: KeepAwakeStatusMsg | undefined, now: number): string | null {
  if (!status?.active) return null;
  if (status.expiresAt === null || status.expiresAt <= now) return 'Awaiting laptop status';
  const minutes = Math.ceil((status.expiresAt - now) / 60_000);
  return minutes >= 60
    ? `${Math.floor(minutes / 60)}h${minutes % 60 ? ` ${minutes % 60}m` : ''} left`
    : `${minutes}m left`;
}

/** The Settings modal's focus pattern, shared by the two device utility sheets. */
function DeviceUtilitySheet({ title, onClose, children }: {
  title: string;
  onClose(): void;
  children: ReactNode;
}): JSX.Element {
  const titleId = useId();
  const overlayRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useLayoutEffect(() => {
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const siblings = Array.from(overlayRef.current?.parentElement?.children ?? [])
      .filter((element): element is HTMLElement => element instanceof HTMLElement && element !== overlayRef.current)
      .map((element) => ({ element, inert: element.inert, hidden: element.getAttribute('aria-hidden') }));
    for (const { element } of siblings) {
      element.inert = true;
      element.setAttribute('aria-hidden', 'true');
    }
    let disposed = false;
    let dismissed = false;
    const dismiss = (): void => {
      if (disposed || dismissed) return;
      dismissed = true;
      onCloseRef.current();
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        dismiss();
      }
      if (event.key !== 'Tab') return;
      const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR) ?? [])
        .filter((element) => element.tabIndex >= 0 && !element.hidden);
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) {
        event.preventDefault();
        dialogRef.current?.focus();
      } else if (!dialogRef.current?.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden') dismiss();
    };
    const removers: Array<() => void> = [];
    const register = (promise: Promise<{ remove(): Promise<void> }>): void => {
      void promise.then((handle) => {
        if (disposed) void handle.remove();
        else removers.push(() => void handle.remove());
      }).catch(() => { /* Browser keyboard/history dismissal remains available without a native bridge. */ });
    };
    register(CapacitorApp.addListener('backButton', dismiss));
    register(CapacitorApp.addListener('appStateChange', ({ isActive }) => {
      if (!isActive) dismiss();
    }));
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('visibilitychange', onVisibility);
    closeRef.current?.focus();
    return () => {
      disposed = true;
      removers.forEach((remove) => remove());
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('visibilitychange', onVisibility);
      for (const { element, inert, hidden } of siblings) {
        element.inert = inert;
        if (hidden === null) element.removeAttribute('aria-hidden');
        else element.setAttribute('aria-hidden', hidden);
      }
      if (trigger?.isConnected && !trigger.matches(':disabled')) trigger.focus();
    };
  }, [titleId]);

  return (
    <div
      ref={overlayRef}
      className="device-utility-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section ref={dialogRef} className="device-utility-sheet" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <header className="device-utility-head">
          <h2 id={titleId}>{title}</h2>
          <button ref={closeRef} type="button" className="device-utility-button" onClick={onClose} aria-label={`Close ${title}`}>
            Close
          </button>
        </header>
        <div className="device-utility-body">{children}</div>
      </section>
    </div>
  );
}

export function DeviceClipboardSheet({ device, onOpen, onClear, onRead, onWrite, onClose }: {
  device: ListenerDeviceState;
  onOpen(channelId: string): void;
  onClear(channelId: string): void;
  onRead(channelId: string): void;
  onWrite(channelId: string, text: string): void;
  onClose(): void;
}): JSX.Element {
  const [draft, setDraft] = useState('');
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  const resultRef = useRef<HTMLTextAreaElement>(null);
  const aliveRef = useRef(false);
  const draftId = useId();
  const limitId = useId();
  const resultId = useId();
  const state = device.clipboard;
  const pending = state?.pending ?? false;
  const textError = clipboardTextError(draft);
  const resultError = state?.operation === 'read' && state.code === 'ok' && state.text !== undefined
    ? clipboardTextError(state.text) : null;
  const error = utilityError(textError ?? resultError ?? state?.code);
  const result = !pending && state?.operation === 'read' && state.code === 'ok' &&
    typeof state.text === 'string' && clipboardTextError(state.text) === null ? state.text : undefined;

  useLayoutEffect(() => {
    aliveRef.current = true;
    onOpen(device.channelId);
    return () => {
      aliveRef.current = false;
      onClear(device.channelId);
    };
  }, [device.channelId, onOpen, onClear]);

  const selectResult = (): void => {
    resultRef.current?.focus();
    resultRef.current?.select();
    setCopyStatus('Text selected. Use your phone’s Copy command.');
  };
  const copyResult = async (): Promise<void> => {
    if (result === undefined) return;
    try {
      if (!navigator.clipboard?.writeText) {
        selectResult();
        return;
      }
      await navigator.clipboard.writeText(result);
      if (aliveRef.current) setCopyStatus('Copied to phone.');
    } catch {
      if (aliveRef.current) selectResult();
    }
  };

  return (
    <DeviceUtilitySheet title="Clipboard" onClose={onClose}>
      <p>Transfer plain text only when you choose. Nothing is read automatically. Text is cleared from Weft when this sheet closes.</p>
      <button type="button" className="device-utility-button" disabled={pending} onClick={() => {
        setCopyStatus(null);
        onRead(device.channelId);
      }}>Read laptop clipboard</button>
      <label htmlFor={draftId}>Text to send to laptop</label>
      <textarea
        id={draftId}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        rows={4}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        aria-describedby={limitId}
        aria-invalid={textError !== null}
        disabled={pending}
      />
      <small id={limitId}>{new TextEncoder().encode(draft).byteLength.toLocaleString()} / {CLIPBOARD_MAX_BYTES.toLocaleString()} UTF-8 bytes (64 KiB maximum). Text is never truncated.</small>
      <button type="button" className="device-utility-button primary" disabled={pending || textError !== null} onClick={() => {
        setCopyStatus(null);
        onWrite(device.channelId, draft);
      }}>Send to laptop</button>
      {pending ? <p role="status">{state?.operation === 'read' ? 'Reading laptop clipboard…' : 'Sending to laptop…'}</p> : null}
      {error ? <p className="device-utility-error" role="alert">{error}</p> : null}
      {!pending && state?.code === 'ok' && state.operation === 'write' ? <p role="status">Sent to laptop.</p> : null}
      {result !== undefined ? (
        <>
          <label htmlFor={resultId}>Returned laptop clipboard text</label>
          <textarea ref={resultRef} id={resultId} value={result} rows={4} readOnly autoComplete="off" spellCheck={false} />
          {result === '' ? <p>The laptop clipboard is empty.</p> : null}
          <div className="device-utility-actions">
            <button type="button" className="device-utility-button" onClick={() => void copyResult()}>Copy returned text to phone</button>
            <button type="button" className="device-utility-button" onClick={selectResult}>Select returned text</button>
          </div>
        </>
      ) : null}
      {copyStatus ? <p role="status">{copyStatus}</p> : null}
    </DeviceUtilitySheet>
  );
}

const KEEP_AWAKE_DURATIONS = [
  { value: KEEP_AWAKE_MIN_MS, label: '15 minutes' },
  { value: 30 * 60_000, label: '30 minutes' },
  { value: 60 * 60_000, label: '1 hour' },
  { value: 2 * 60 * 60_000, label: '2 hours' },
  { value: 4 * 60 * 60_000, label: '4 hours' },
  { value: KEEP_AWAKE_MAX_MS, label: '8 hours' },
];

export function DeviceKeepAwakeSheet({ device, onRefresh, onStart, onStop, onClose }: {
  device: ListenerDeviceState;
  onRefresh(channelId: string): void;
  onStart(channelId: string, durationMs: number): void;
  onStop(channelId: string): void;
  onClose(): void;
}): JSX.Element {
  const [durationMs, setDurationMs] = useState(KEEP_AWAKE_MIN_MS);
  const durationId = useId();
  const state = device.keepAwake;
  const pending = state?.pending ?? false;
  const active = state?.status?.active ?? false;
  const remaining = keepAwakeRemaining(state?.status, useNowTick(5_000));
  const error = utilityError(state?.code ?? state?.status?.code);
  useEffect(() => { onRefresh(device.channelId); }, [device.channelId, onRefresh]);

  return (
    <DeviceUtilitySheet title="Keep Awake" onClose={onClose}>
      <p>Prevent system sleep for a limited time. The laptop display can still turn off. Normal sleep settings return when the lease ends.</p>
      <p role="status">{pending ? 'Updating Keep Awake…' : active ? `Keeping system awake · ${remaining}` : state?.status ? 'Keep Awake is off.' : 'Waiting for laptop status…'}</p>
      <label htmlFor={durationId}>Keep Awake duration</label>
      <select id={durationId} value={durationMs} disabled={pending} onChange={(event) => setDurationMs(Number(event.target.value))}>
        {KEEP_AWAKE_DURATIONS.map(({ value, label }) => <option key={value} value={value}>{label}</option>)}
      </select>
      <div className="device-utility-actions">
        <button type="button" className="device-utility-button primary" disabled={pending} onClick={() => onStart(device.channelId, durationMs)}>
          {active ? 'Extend keeping awake' : 'Start keeping awake'}
        </button>
        {active ? <button type="button" className="device-utility-button" disabled={pending} onClick={() => onStop(device.channelId)}>Stop keeping awake</button> : null}
      </div>
      {error ? <p className="device-utility-error" role="alert">{error}</p> : null}
      <p>Closing this sheet does not stop Keep Awake. The laptop controls the lease and its expiry.</p>
    </DeviceUtilitySheet>
  );
}
