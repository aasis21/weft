import { type JSX } from 'react';
import { setVoiceAutoRelisten, setVoiceSilenceSeconds } from '@/lib/settings';

interface VoxSettingsProps {
  autoRelisten: boolean;
  silenceMs: number;
}

/**
 * Vox quick settings, in the shape of the real Settings screen (same switch and segment controls),
 * because this is a hands-free mode — it gets used one-handed, or not-handed, at arm's length. Big
 * targets, plain words, no slider to land precisely on while you're driving (#187).
 */
const PAUSE_CHOICES = [
  { seconds: 1.5, label: 'Snappy' },
  { seconds: 3.2, label: 'Normal' },
  { seconds: 5, label: 'Relaxed' },
  { seconds: 8, label: 'Thinking' },
];

export function VoxSettings({ autoRelisten, silenceMs }: VoxSettingsProps): JSX.Element {
  const seconds = Math.round((silenceMs / 1000) * 10) / 10;
  const closest = PAUSE_CHOICES.reduce((best, option) =>
    Math.abs(option.seconds - seconds) < Math.abs(best.seconds - seconds) ? option : best,
  );

  return (
    <section className="vox-settings settings-group" aria-label="Vox settings">
      <div className="settings-row-head">
        <div>
          <h2 id="vox-relisten-title">Keep listening</h2>
          <p>Reopen the mic on its own once Weft finishes speaking.</p>
        </div>
        <label className="settings-switch">
          <input
            type="checkbox"
            aria-labelledby="vox-relisten-title"
            checked={autoRelisten}
            onChange={(event) => void setVoiceAutoRelisten(event.currentTarget.checked)}
          />
          <span aria-hidden="true" />
        </label>
      </div>

      <div className="settings-row-head">
        <div>
          <h2 id="vox-pause-title">Pause before sending</h2>
          <p>How long a silence means you're done talking.</p>
        </div>
      </div>
      <div className="settings-segments" role="radiogroup" aria-labelledby="vox-pause-title">
        {PAUSE_CHOICES.map((option) => (
          <button
            key={option.seconds}
            type="button"
            role="radio"
            aria-checked={option.seconds === closest.seconds}
            className={`settings-segment${option.seconds === closest.seconds ? ' active' : ''}`}
            onClick={() => void setVoiceSilenceSeconds(option.seconds)}
          >
            <span className="vox-segment-label">{option.label}</span>
            <span className="vox-segment-value">{option.seconds}s</span>
          </button>
        ))}
      </div>
    </section>
  );
}
