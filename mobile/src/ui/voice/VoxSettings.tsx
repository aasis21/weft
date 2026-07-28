import { type JSX } from 'react';
import {
  VOICE_SILENCE_MAX,
  VOICE_SILENCE_MIN,
  setVoiceAutoRelisten,
  setVoiceSilenceSeconds,
} from '@/lib/settings';

interface VoxSettingsProps {
  autoRelisten: boolean;
  silenceMs: number;
}

/**
 * The two knobs worth reaching for in the middle of a conversation: whether Vox picks the mic back
 * up after it finishes speaking, and how long a pause counts as "done talking" (#186).
 *
 * Writes straight to settings — the engine subscribes, so a change lands on the very next word.
 */
export function VoxSettings({ autoRelisten, silenceMs }: VoxSettingsProps): JSX.Element {
  const seconds = Math.round((silenceMs / 1000) * 10) / 10;
  return (
    <div className="vox-settings">
      <label className="vox-setting vox-setting-row">
        <span>Keep listening after I reply</span>
        <input
          type="checkbox"
          checked={autoRelisten}
          onChange={(event) => void setVoiceAutoRelisten(event.target.checked)}
        />
      </label>
      <label className="vox-setting">
        <span className="vox-setting-row">
          <span>Pause before sending</span>
          <span className="vox-setting-value">{seconds.toFixed(1)}s</span>
        </span>
        <input
          type="range"
          min={VOICE_SILENCE_MIN}
          max={VOICE_SILENCE_MAX}
          step={0.5}
          value={seconds}
          aria-label="Pause before sending, in seconds"
          onChange={(event) => void setVoiceSilenceSeconds(Number(event.target.value))}
        />
      </label>
    </div>
  );
}
