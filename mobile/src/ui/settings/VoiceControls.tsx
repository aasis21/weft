import { useEffect, useState, type JSX } from 'react';
import {
  VOICE_LANGUAGES,
  getSettings,
  setVoiceAutoRelisten,
  setVoiceContinuous,
  setVoiceLanguage,
  setVoiceSilenceSeconds,
  setVoiceSpeakStreaming,
  subscribeSettings,
} from '@/lib/settings';

/** The four voice controls, in one place. Settings and the in-session Vox panel used to carry
 *  different subsets of these, so turning something on in one place left the other lying about
 *  the current state. Both now render this component and read the same store. */
interface VoiceControlsProps {
  /** Live engine values, when rendered inside an open Vox session — they can lead the store by a
   *  frame, so prefer them for display when supplied. */
  autoRelisten?: boolean;
  silenceMs?: number;
  /** `false` inside the Vox panel, where the heading is the panel itself. */
  showHeading?: boolean;
  /** Settings only. The recognition language is set once and forgotten, so it would only be clutter
   *  in the panel you open mid-conversation. */
  showLanguage?: boolean;
}

const PAUSE_CHOICES = [
  { seconds: 1.5, label: 'Snappy' },
  { seconds: 3.2, label: 'Normal' },
  { seconds: 5, label: 'Relaxed' },
  { seconds: 8, label: 'Thinking' },
];

export function VoiceControls({
  autoRelisten,
  silenceMs,
  showHeading = false,
  showLanguage = false,
}: VoiceControlsProps): JSX.Element {
  const [stored, setStored] = useState({
    voiceAutoRelisten: false,
    voiceContinuous: false,
    voiceSpeakStreaming: false,
    voiceSilenceSeconds: 3.2,
    voiceLanguage: '',
  });

  useEffect(() => {
    void getSettings().then((s) =>
      setStored({
        voiceAutoRelisten: s.voiceAutoRelisten,
        voiceContinuous: s.voiceContinuous,
        voiceSpeakStreaming: s.voiceSpeakStreaming,
        voiceSilenceSeconds: s.voiceSilenceSeconds,
        voiceLanguage: s.voiceLanguage,
      }),
    );
    return subscribeSettings((s) =>
      setStored({
        voiceAutoRelisten: s.voiceAutoRelisten,
        voiceContinuous: s.voiceContinuous,
        voiceSpeakStreaming: s.voiceSpeakStreaming,
        voiceSilenceSeconds: s.voiceSilenceSeconds,
        voiceLanguage: s.voiceLanguage,
      }),
    );
  }, []);

  const relisten = autoRelisten ?? stored.voiceAutoRelisten;
  const seconds = silenceMs === undefined ? stored.voiceSilenceSeconds : Math.round((silenceMs / 1000) * 10) / 10;
  const closest = PAUSE_CHOICES.reduce((best, option) =>
    Math.abs(option.seconds - seconds) < Math.abs(best.seconds - seconds) ? option : best,
  );

  return (
    <>
      {showHeading ? (
        <div className="settings-row-head settings-group-title">
          <div>
            <h2 id="settings-voice-title">Voice</h2>
            <p>How Vox listens and speaks on this phone.</p>
          </div>
        </div>
      ) : null}

      {showLanguage ? (
        <>
          <div className="settings-row-head">
            <div>
              <h2 id="vox-language-title">Speech language</h2>
              <p>Which accent and vocabulary the recogniser listens for. English (India) hears Indian
                English far better than the US model. Hindi writes in Devanagari and won't mix English
                words in, so pick it only when you'll speak Hindi throughout.</p>
            </div>
          </div>
          <div
            className="settings-segments settings-segments-pause"
            role="radiogroup"
            aria-labelledby="vox-language-title"
          >
            {VOICE_LANGUAGES.map((option) => (
              <button
                key={option.value || 'auto'}
                type="button"
                role="radio"
                aria-checked={option.value === stored.voiceLanguage}
                className={`settings-segment${option.value === stored.voiceLanguage ? ' active' : ''}`}
                onClick={() => void setVoiceLanguage(option.value)}
              >
                <span className="vox-segment-label">{option.label}</span>
                <span className="vox-segment-value">{option.value || navigator.language}</span>
              </button>
            ))}
          </div>
        </>
      ) : null}

      <div className="settings-row-head">
        <div>
          <h2 id="vox-relisten-title">Keep listening</h2>
          <p>Reopen the mic on its own once Weft finishes speaking.</p>
        </div>
        <label className="settings-switch">
          <input
            type="checkbox"
            aria-labelledby="vox-relisten-title"
            checked={relisten}
            onChange={(event) => void setVoiceAutoRelisten(event.currentTarget.checked)}
          />
          <span aria-hidden="true" />
        </label>
      </div>

      <div className="settings-row-head">
        <div>
          <h2 id="vox-continuous-title">Hold the mic open</h2>
          <p>One long listen instead of reopening at every pause. Quieter, but some phones garble
            long dictation — turn it off if words repeat themselves.</p>
        </div>
        <label className="settings-switch">
          <input
            type="checkbox"
            aria-labelledby="vox-continuous-title"
            checked={stored.voiceContinuous}
            onChange={(event) => void setVoiceContinuous(event.currentTarget.checked)}
          />
          <span aria-hidden="true" />
        </label>
      </div>

      <div className="settings-row-head">
        <div>
          <h2 id="vox-stream-title">Speak as it writes</h2>
          <p>Start reading a sentence before the agent has finished it.</p>
        </div>
        <label className="settings-switch">
          <input
            type="checkbox"
            aria-labelledby="vox-stream-title"
            checked={stored.voiceSpeakStreaming}
            onChange={(event) => void setVoiceSpeakStreaming(event.currentTarget.checked)}
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
      <div className="settings-segments settings-segments-pause" role="radiogroup" aria-labelledby="vox-pause-title">
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
    </>
  );
}
