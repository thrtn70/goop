import { Component, type ReactNode } from "react";

type Props = { resetKey: string; children: ReactNode };
type State = { failed: boolean; key: string };

/**
 * Keeps a failing player from taking the page down with it.
 * Unlike components/ErrorBoundary this never reloads the app: it swaps the player for a quiet status line
 * and tries again when `resetKey` (the selected source) changes.
 */
export default class PlayerBoundary extends Component<Props, State> {
  state: State = { failed: false, key: this.props.resetKey };

  static getDerivedStateFromError(): Partial<State> {
    return { failed: true };
  }

  static getDerivedStateFromProps(props: Props, state: State): State | null {
    return props.resetKey === state.key ? null : { failed: false, key: props.resetKey };
  }

  componentDidCatch(error: Error): void {
    console.error("Source player failed", error);
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <p role="status" className="rounded-md bg-surface-0 px-3 py-2 text-xs text-fg-muted">
        Preview unavailable.
      </p>
    );
  }
}
