import { Component, type ReactNode } from "react";

type Props = { children: ReactNode };
type State = { error: Error | undefined };

/**
 * Top-level error boundary. Catches render-time exceptions so a single broken
 * route doesn't blank the entire shell. Logs to console for the dev tools and
 * shows a recoverable card with a Reload action.
 */
export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { error: undefined };
  }

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }): void {
    // eslint-disable-next-line no-console
    console.error("[ErrorBoundary]", error, info.componentStack ?? "");
  }

  reset = () => {
    this.setState({ error: undefined });
  };

  override render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <div className="m-6 max-w-2xl rounded-[var(--radius-card)] border border-app-danger/40 bg-app-danger-soft p-5 text-sm">
        <h2 className="text-base font-semibold text-app-danger">Render error</h2>
        <p className="mt-2 text-app-text">{this.state.error.message}</p>
        {this.state.error.stack ? (
          <pre className="mt-3 max-h-60 overflow-auto whitespace-pre-wrap rounded-md bg-app-surface-2 p-3 font-mono text-[11px] text-app-text-muted">
            {this.state.error.stack}
          </pre>
        ) : null}
        <div className="mt-3 flex gap-2">
          <button
            type="button"
            onClick={this.reset}
            className="rounded-md border border-app-border bg-app-surface-2 px-3 py-1.5 text-xs"
          >
            Try again
          </button>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="rounded-md bg-app-accent px-3 py-1.5 text-xs font-semibold text-app-bg"
          >
            Reload page
          </button>
        </div>
      </div>
    );
  }
}
