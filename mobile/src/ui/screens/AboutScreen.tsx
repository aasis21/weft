import type { JSX } from 'react';
import type { ListenerDeviceState } from '@/session/model';
import { WeftMark } from '@/ui/brand/WeftMark';
import { deviceLabel } from '@/ui/screens/deviceDisplay';
import { isNativeRuntime } from '@/ui/hooks/usePairing';
import {
  ANDROID_APK_URL, RELEASES_URL, compareVersions, phonePlatform, useLatestRelease,
} from '@/lib/getApp';

const DOCS = 'https://aasis21.github.io/weft/';
const REPO = 'https://github.com/aasis21/weft';

interface AboutScreenProps {
  devices: ListenerDeviceState[];
  onBack(): void;
  onOpenProduct(): void;
}

/** Compact About for people already using Weft: versions, the app download, and links. */
export function AboutScreen({ devices, onBack, onOpenProduct }: AboutScreenProps): JSX.Element {
  const appVersion = import.meta.env.VITE_APP_VERSION ?? 'dev';
  const native = isNativeRuntime();
  const platform = phonePlatform();
  const release = useLatestRelease();
  const updateAvailable = !!release && appVersion !== 'dev' && compareVersions(release.version, appVersion) > 0;
  const realDevices = devices.filter((device) => device.transport.kind !== 'local');
  const showDownload = platform === 'android' && (!native || updateAvailable);

  return (
    <main className="weft-session join-session about-screen">
      <header className="status-bar">
        <button className="icon-btn" type="button" onClick={onBack} aria-label="Back">‹</button>
        <div className="status-id">
          <span className="status-title">About Weft</span>
        </div>
      </header>
      <div className="session-join-inner about-inner">
        <div className="about-brand">
          <WeftMark size={34} />
          <div>
            <strong>Weft</strong>
            <span>Your Copilot session, off the desk.</span>
          </div>
        </div>

        <dl className="about-versions">
          <div>
            <dt>This phone</dt>
            <dd>{appVersion}{native ? ' (Android app)' : ' (web)'}</dd>
          </div>
          {realDevices.map((device) => (
            <div key={device.channelId}>
              <dt>{deviceLabel(device)}</dt>
              <dd>{device.appVersion ?? 'Version unknown'}</dd>
            </div>
          ))}
          {release ? (
            <div>
              <dt>Latest release</dt>
              <dd>{release.version}{updateAvailable ? <span className="about-update">Update available</span> : null}</dd>
            </div>
          ) : null}
        </dl>

        {showDownload ? (
          <a className="session-primary-action about-download" href={ANDROID_APK_URL} rel="noopener">
            {native ? `Update the Android app to ${release?.version ?? 'latest'}` : 'Get the Android app'}
          </a>
        ) : null}

        <nav className="about-links" aria-label="Weft links">
          <a href={RELEASES_URL} target="_blank" rel="noreferrer">What&apos;s new <span aria-hidden="true">›</span></a>
          <a href={DOCS} target="_blank" rel="noreferrer">Documentation <span aria-hidden="true">›</span></a>
          <a href={`${REPO}/blob/main/PRIVACY.md`} target="_blank" rel="noreferrer">Privacy <span aria-hidden="true">›</span></a>
          <a href={`${REPO}/blob/main/SUPPORT.md`} target="_blank" rel="noreferrer">Support <span aria-hidden="true">›</span></a>
          <button type="button" onClick={onOpenProduct}>View product page <span aria-hidden="true">›</span></button>
        </nav>
      </div>
    </main>
  );
}
