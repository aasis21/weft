import { describe, expect, it } from 'vitest';

import { deriveStatus } from '../sessionStatus';

type View = Parameters<typeof deriveStatus>[0];

const view = (over: Partial<View>): View => ({ status: 'idle', cold: false, error: undefined, ...over });

describe('deriveStatus (#163 single source of truth)', () => {
  it('maps Ended above everything else', () => {
    const s = deriveStatus(view({ status: 'ended', cold: true, error: 'boom' }), { busy: true });
    expect(s).toEqual({ label: 'Ended', tone: 'ended', active: false });
  });

  it('treats a reachability error as Offline (not Active) even when status still says live', () => {
    const s = deriveStatus(view({ status: 'live', error: 'unreachable' }));
    expect(s).toEqual({ label: 'Offline', tone: 'error', active: false });
  });

  it('shows Working… for a busy live turn', () => {
    const s = deriveStatus(view({ status: 'live' }), { busy: true });
    expect(s).toEqual({ label: 'Working…', tone: 'busy', active: true });
  });

  it('shows Archived (calm, not error) for a healthy cold session', () => {
    expect(deriveStatus(view({ status: 'idle', cold: true }))).toEqual({
      label: 'Archived',
      tone: 'archived',
      active: false,
    });
    expect(deriveStatus(view({ status: 'live', cold: true }))).toEqual({
      label: 'Archived',
      tone: 'archived',
      active: false,
    });
  });

  it('maps the healthy subscribed states', () => {
    expect(deriveStatus(view({ status: 'live' }))).toEqual({ label: 'Live', tone: 'live', active: true });
    expect(deriveStatus(view({ status: 'idle' }))).toEqual({ label: 'Quiet', tone: 'idle', active: true });
    expect(deriveStatus(view({ status: 'connecting' }))).toEqual({
      label: 'Connecting…',
      tone: 'connecting',
      active: true,
    });
  });

  it('falls back to Initializing… for unknown/initializing (not Active)', () => {
    expect(deriveStatus(view({ status: 'initializing' }))).toEqual({
      label: 'Initializing…',
      tone: 'initializing',
      active: false,
    });
  });
});
