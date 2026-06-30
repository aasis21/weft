import { MODES } from '@aasis21/helm-shared';
import type { SessionMode } from '@aasis21/helm-shared';

interface ModeSelectorProps {
  mode: SessionMode;
  onChange(mode: SessionMode): Promise<void>;
}

export function ModeSelector({ mode, onChange }: ModeSelectorProps): JSX.Element {
  return (
    <div className="mode-selector" role="group" aria-label="Session mode">
      {MODES.map((item) => (
        <button
          key={item}
          className={item === mode ? 'active' : ''}
          type="button"
          onClick={() => void onChange(item)}
        >
          {item}
        </button>
      ))}
    </div>
  );
}
