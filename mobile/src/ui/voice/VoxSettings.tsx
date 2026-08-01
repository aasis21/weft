import { type JSX } from 'react';
import { VoiceControls } from '@/ui/settings/VoiceControls';

interface VoxSettingsProps {
  autoRelisten: boolean;
  silenceMs: number;
}

/**
 * Vox quick settings, in the shape of the real Settings screen (same switch and segment controls),
 * because this is a hands-free mode — it gets used one-handed, or not-handed, at arm's length. Big
 * targets, plain words, no slider to land precisely on while you're driving (#187). The controls
 * themselves are shared with Settings so the two can't drift apart.
 */
export function VoxSettings({ autoRelisten, silenceMs }: VoxSettingsProps): JSX.Element {
  return (
    <section className="vox-settings settings-group" aria-label="Vox settings">
      <VoiceControls autoRelisten={autoRelisten} silenceMs={silenceMs} compact />
    </section>
  );
}
