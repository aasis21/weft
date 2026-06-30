// On-device alerting for Helm.
//
// The product promise is "walk away from your desk" — so when Copilot pauses for a
// permission decision, the phone must surface it even when the app isn't in focus.
// This module renders an OS notification (native via @capacitor/local-notifications,
// or the Web Notifications API in a plain browser) and buzzes the device.
//
// Privacy: notifications carry only the tool *name*, never tool arguments or any stream
// content. The actual request still travels E2E-encrypted over the relay; the alert is
// just a "come look" nudge. Nothing here is logged or sent anywhere.
//
// Reliability note: while the app is open or recently backgrounded, the live Realtime
// socket delivers the approval and this fires immediately. Once Android fully suspends a
// swiped-away app the socket drops and only a real push (FCM) can wake it — that is the
// planned follow-up; this layer covers the common "phone in hand / app recent" case.

import { Capacitor } from '@capacitor/core';
import type { ApprovalRequest } from '@aasis21/helm-shared';

const APPROVAL_CHANNEL = 'helm-approvals';

interface LocalNotificationsApi {
  checkPermissions(): Promise<{ display: string }>;
  requestPermissions(): Promise<{ display: string }>;
  schedule(opts: { notifications: Array<Record<string, unknown>> }): Promise<unknown>;
  createChannel?(channel: Record<string, unknown>): Promise<void>;
}

type PermissionState = 'unknown' | 'granted' | 'denied';

let nativePlugin: LocalNotificationsApi | null = null;
let permissionState: PermissionState = 'unknown';
let channelReady = false;

function isNative(): boolean {
  try {
    return Capacitor.isNativePlatform();
  } catch {
    return false;
  }
}

/** True when the app is not the user's current focus (backgrounded or tab hidden). */
export function appIsHidden(): boolean {
  try {
    return typeof document !== 'undefined' && document.visibilityState === 'hidden';
  } catch {
    return false;
  }
}

/** Stable 31-bit id from the requestId so re-broadcasts replace rather than stack. */
export function notificationIdFor(requestId: string): number {
  let hash = 0;
  for (let i = 0; i < requestId.length; i += 1) {
    hash = (Math.imul(31, hash) + requestId.charCodeAt(i)) | 0;
  }
  // Mask to a non-negative 31-bit int: Android notification ids must fit a Java int.
  return (hash & 0x7fffffff) || 1;
}

/** OS-visible copy for an approval. Tool name only — never arguments. */
export function approvalNotification(req: ApprovalRequest): { title: string; body: string } {
  const tool = req.toolName?.trim() || 'an action';
  return { title: 'Copilot needs your approval', body: `Allow ${tool}?` };
}

async function loadNative(): Promise<LocalNotificationsApi | null> {
  if (!isNative()) return null;
  if (nativePlugin) return nativePlugin;
  const mod = await import('@capacitor/local-notifications');
  nativePlugin = mod.LocalNotifications as unknown as LocalNotificationsApi;
  if (!channelReady) {
    // Android 8+ needs a channel; MAX importance gives a heads-up banner + sound + buzz.
    await nativePlugin.createChannel?.({
      id: APPROVAL_CHANNEL,
      name: 'Approval requests',
      description: 'Copilot is waiting for you to approve or deny an action.',
      importance: 5,
      visibility: 1,
      vibration: true,
    }).catch(() => undefined);
    channelReady = true;
  }
  return nativePlugin;
}

/**
 * Ask for notification permission. Idempotent and safe to call eagerly on connect.
 * Returns true if alerts can be shown.
 */
export async function ensureNotificationPermission(): Promise<boolean> {
  if (permissionState === 'granted') return true;
  if (permissionState === 'denied') return false;
  try {
    if (isNative()) {
      const plugin = await loadNative();
      if (!plugin) return false;
      const current = await plugin.checkPermissions().catch(() => ({ display: 'prompt' }));
      const result = current.display === 'granted' ? current : await plugin.requestPermissions();
      permissionState = result.display === 'granted' ? 'granted' : 'denied';
      return permissionState === 'granted';
    }
    if (typeof Notification === 'undefined') return false;
    if (Notification.permission === 'granted') {
      permissionState = 'granted';
      return true;
    }
    if (Notification.permission === 'denied') {
      permissionState = 'denied';
      return false;
    }
    const granted = (await Notification.requestPermission()) === 'granted';
    permissionState = granted ? 'granted' : 'denied';
    return granted;
  } catch {
    return false;
  }
}

function buzz(): void {
  try {
    navigator.vibrate?.([0, 140, 70, 140]);
  } catch {
    /* not supported — the OS notification itself vibrates */
  }
}

/**
 * Alert the user that Copilot is waiting on an approval. Always buzzes; raises an OS
 * notification only when the app is backgrounded (in the foreground the ApprovalCard is
 * already on screen, so a banner would just be noise).
 */
export async function notifyApprovalRequest(req: ApprovalRequest): Promise<void> {
  buzz();
  if (!appIsHidden()) return;
  if (!(await ensureNotificationPermission())) return;
  const { title, body } = approvalNotification(req);
  try {
    if (isNative()) {
      const plugin = await loadNative();
      await plugin?.schedule({
        notifications: [
          {
            id: notificationIdFor(req.requestId),
            channelId: APPROVAL_CHANNEL,
            title,
            body,
            extra: { requestId: req.requestId },
          },
        ],
      });
    } else if (typeof Notification !== 'undefined') {
      const note = new Notification(title, { body, tag: `helm-approval-${req.requestId}` });
      note.onclick = () => {
        try {
          window.focus();
        } catch {
          /* ignore */
        }
        note.close();
      };
    }
  } catch {
    /* best-effort: a failed alert must never break the live stream */
  }
}

/** Lower-priority heads-up that the bound session ended while you were away. */
export async function notifySessionEnded(reason?: string): Promise<void> {
  if (!appIsHidden()) return;
  if (!(await ensureNotificationPermission())) return;
  const title = 'Helm session ended';
  const body = reason?.trim() || 'Your Copilot session disconnected.';
  try {
    if (isNative()) {
      const plugin = await loadNative();
      await plugin?.schedule({
        notifications: [{ id: notificationIdFor(`end-${reason ?? ''}`), title, body }],
      });
    } else if (typeof Notification !== 'undefined') {
      new Notification(title, { body, tag: 'helm-session-ended' });
    }
  } catch {
    /* best-effort */
  }
}
