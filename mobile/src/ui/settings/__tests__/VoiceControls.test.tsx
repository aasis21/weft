import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { VoiceControls } from '@/ui/settings/VoiceControls';

describe('VoiceControls', () => {
  it('explains every switch on the Settings screen', () => {
    render(<VoiceControls showHeading showLanguage />);

    expect(screen.getByText('Keep listening')).toBeInTheDocument();
    expect(screen.getByText(/Reopen the mic on its own/)).toBeInTheDocument();
    expect(screen.getByText(/One long listen instead of reopening/)).toBeInTheDocument();
    expect(screen.getByText(/Start reading a sentence before/)).toBeInTheDocument();
    expect(screen.getByText(/How long a silence means/)).toBeInTheDocument();
  });

  it('drops the explanations in the hands-free Vox panel, keeping the titles', () => {
    render(<VoiceControls compact />);

    // The labels you scan for are still there — it is the paragraphs underneath them, which push
    // the mic orb off the bottom of the sheet, that go.
    expect(screen.getByText('Keep listening')).toBeInTheDocument();
    expect(screen.getByText('Hold the mic open')).toBeInTheDocument();
    expect(screen.getByText('Speak as it writes')).toBeInTheDocument();
    expect(screen.getByText('Pause before sending')).toBeInTheDocument();

    expect(screen.queryByText(/Reopen the mic on its own/)).toBeNull();
    expect(screen.queryByText(/One long listen instead of reopening/)).toBeNull();
    expect(screen.queryByText(/Start reading a sentence before/)).toBeNull();
    expect(screen.queryByText(/How long a silence means/)).toBeNull();
  });
});
