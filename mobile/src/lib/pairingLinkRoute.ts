import { App as CapacitorApp } from '@capacitor/app';
import { decodePairingInput, isPairingLink } from '@aasis21/weft-shared';

/** Scanned or pasted text (pairing link or raw payload JSON) as the payload JSON the runtime pairs with. */
export function normalizePairingCode(raw: string): string {
  return JSON.stringify(decodePairingInput(raw));
}

/** A pairing link that carries a code in its fragment, or null. */
export function pairingLinkWithCode(url: string | null | undefined): string | null {
  return url && isPairingLink(url) && new URL(url.trim()).hash.length > 1 ? url.trim() : null;
}

/**
 * Web `/pair#v3.<code>` landing: return the pairing link and immediately scrub the credential from
 * the address bar and history.
 */
export function takePairingLinkFromLocation(
  location: Location = window.location,
  history: History = window.history,
): string | null {
  if (!/^\/pair\/?$/.test(location.pathname)) return null;
  const link = pairingLinkWithCode(`${location.origin}${location.pathname}${location.hash}`);
  history.replaceState(null, '', '/');
  return link;
}

const LAUNCH_LINK_HANDLED_KEY = 'weft.pairingLaunchLinkHandled';
let lastDeliveredLink: string | null = null;

/**
 * Native App Links: deliver pairing links the OS opens the app with. `appUrlOpen` covers links
 * opened while running; `getLaunchUrl` covers a cold start, at most once per WebView session so a
 * reload never replays a used code.
 */
export function listenForPairingLinks(onLink: (link: string) => void): () => void {
  let disposed = false;
  const deliver = (url: string | null | undefined): boolean => {
    const link = pairingLinkWithCode(url);
    if (!link || disposed || link === lastDeliveredLink) return false;
    lastDeliveredLink = link;
    onLink(link);
    return true;
  };
  const handle = Promise.resolve(
    CapacitorApp.addListener?.('appUrlOpen', ({ url }) => void deliver(url)),
  ).catch(() => undefined);
  if (sessionStorage.getItem(LAUNCH_LINK_HANDLED_KEY) !== '1') {
    void Promise.resolve(CapacitorApp.getLaunchUrl?.())
      .then((launch) => {
        if (deliver(launch?.url)) sessionStorage.setItem(LAUNCH_LINK_HANDLED_KEY, '1');
      })
      .catch(() => undefined);
  }
  return () => {
    disposed = true;
    void handle.then((h) => h?.remove());
  };
}
