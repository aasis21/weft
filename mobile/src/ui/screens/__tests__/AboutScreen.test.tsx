import { Capacitor } from '@capacitor/core';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ListenerDeviceState } from '@/session/model';
import { AboutScreen } from '@/ui/screens/AboutScreen';
import { ANDROID_APK_URL, compareVersions } from '@/lib/getApp';

const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 15; Pixel) AppleWebKit/537.36 Chrome/131 Mobile Safari/537.36';

function mockLatest(version: string): void {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ tag_name: `v${version}`, assets: [{ name: 'weft-android.apk', size: 27_200_000 }] }),
  }));
}

const laptop = {
  channelId: 'dev-1', name: 'AKASH-LAPTOP', appVersion: '0.2.71', transport: { kind: 'supabase' },
} as unknown as ListenerDeviceState;
const demo = { channelId: 'demo', name: 'Demo laptop', transport: { kind: 'local' } } as unknown as ListenerDeviceState;

describe('AboutScreen', () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.stubEnv('VITE_APP_VERSION', '0.2.71');
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(ANDROID_UA);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('lists real laptop versions and offers the APK in an Android browser', async () => {
    mockLatest('0.2.71');
    const user = userEvent.setup();
    const onOpenProduct = vi.fn();
    render(<AboutScreen devices={[laptop, demo]} onBack={vi.fn()} onOpenProduct={onOpenProduct} />);

    expect(screen.getByText('AKASH-LAPTOP')).toBeInTheDocument();
    expect(screen.queryByText('Demo laptop')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Get the Android app' })).toHaveAttribute('href', ANDROID_APK_URL);
    await user.click(screen.getByRole('button', { name: /View product page/ }));
    expect(onOpenProduct).toHaveBeenCalledTimes(1);
  });

  it('inside the Android app, offers a download only when a newer release exists', async () => {
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(true);
    mockLatest('99.0.0');
    render(<AboutScreen devices={[]} onBack={vi.fn()} onOpenProduct={vi.fn()} />);
    expect(await screen.findByText('Update available')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Update the Android app to 99.0.0' })).toHaveAttribute('href', ANDROID_APK_URL);
  });

  it('inside the Android app, shows no download when it is current', async () => {
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(true);
    mockLatest('0.0.1');
    render(<AboutScreen devices={[]} onBack={vi.fn()} onOpenProduct={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('Latest release')).toBeInTheDocument());
    expect(screen.queryByRole('link', { name: /Android app/ })).not.toBeInTheDocument();
  });

  it('compares versions numerically', () => {
    expect(compareVersions('0.2.10', '0.2.9')).toBeGreaterThan(0);
    expect(compareVersions('v0.2.71', '0.2.71')).toBe(0);
    expect(compareVersions('0.2.7', '0.3.0')).toBeLessThan(0);
  });
});
