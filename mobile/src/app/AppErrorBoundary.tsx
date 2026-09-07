// SPDX-License-Identifier: Apache-2.0
import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  failed: boolean;
}

export class AppErrorBoundary extends Component<Props, State> {
  override state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Weft failed to render', error, info.componentStack);
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="boot" role="alert">
        <div className="boot-mark" aria-hidden="true">W</div>
        <p>Weft could not open this screen.</p>
        <button type="button" className="primary-action" onClick={() => window.location.reload()}>
          Reload Weft
        </button>
        <a href="https://github.com/aasis21/weft/issues/new" target="_blank" rel="noreferrer">
          Report this problem
        </a>
      </main>
    );
  }
}
