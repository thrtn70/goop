import { Component } from "react";
import type { ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export default class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  render(): ReactNode {
    if (!this.state.hasError) return this.props.children;

    return (
      <div className="flex h-screen items-center justify-center bg-surface-0 p-8">
        <div className="max-w-md text-center">
          <p className="font-display text-lg font-semibold text-fg">Something went wrong</p>
          <p className="mt-2 text-sm text-fg-secondary">
            Goop hit an unexpected error. This is a bug on our end, not something you did.
          </p>
          {this.state.error && (
            <p className="mt-3 rounded-md bg-surface-2 p-3 text-left text-xs text-fg-muted">
              {this.state.error.message}
            </p>
          )}
          <button
            type="button"
            onClick={() => {
              this.setState({ hasError: false, error: null });
              window.location.hash = "";
              window.location.reload();
            }}
            className="btn-press mt-4 rounded-md bg-accent px-4 py-2 text-sm font-semibold text-accent-fg transition duration-fast ease-out hover:bg-accent-hover"
          >
            Reload Goop
          </button>
        </div>
      </div>
    );
  }
}
