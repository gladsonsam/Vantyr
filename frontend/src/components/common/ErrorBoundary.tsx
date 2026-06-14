import { Component, type ErrorInfo, type ReactNode } from "react";

interface ErrorBoundaryProps {
  children: ReactNode;
  /** Custom fallback UI; falls back to a styled default when omitted. */
  fallback?: ReactNode;
  /** When this value changes, the boundary resets (e.g. route path or tab id). */
  resetKey?: string | number;
  /** Label included in the logged error for easier diagnosis. */
  label?: string;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Catches render-phase errors in its subtree so one bad component (e.g. a
 * telemetry row built from agent-supplied data) can't white-screen the whole
 * dashboard. Pass `resetKey` to auto-recover on navigation/tab change.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidUpdate(prevProps: ErrorBoundaryProps) {
    if (prevProps.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Surface to the console (and any future error-reporting sink). This is an
    // observability product, so a swallowed render crash is worse than noisy logs.
    console.error(`[ErrorBoundary${this.props.label ? ` · ${this.props.label}` : ""}]`, error, info.componentStack);
  }

  private reset = () => this.setState({ error: null });

  render() {
    if (this.state.error) {
      if (this.props.fallback !== undefined) return this.props.fallback;
      return <DefaultFallback error={this.state.error} onReset={this.reset} />;
    }
    return this.props.children;
  }
}

function DefaultFallback({ error, onReset }: { error: Error; onReset: () => void }) {
  return (
    <div
      role="alert"
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 14,
        minHeight: 280,
        padding: 32,
        textAlign: "center",
        color: "var(--tx-2)",
        fontFamily: "var(--font)",
      }}
    >
      <div style={{ fontSize: 16, fontWeight: 700, color: "var(--tx)", fontFamily: "var(--display)" }}>
        Something went wrong
      </div>
      <div style={{ fontSize: 13, color: "var(--tx-3)", maxWidth: 520 }}>
        This part of the dashboard hit an unexpected error. Your session is still active — you can retry or reload.
      </div>
      <div
        style={{
          fontSize: 12,
          fontFamily: "var(--mono)",
          color: "var(--tx-4)",
          maxWidth: 560,
          overflowWrap: "anywhere",
        }}
      >
        {error.message}
      </div>
      <div style={{ display: "flex", gap: 10, marginTop: 4 }}>
        <button
          type="button"
          onClick={onReset}
          style={{
            padding: "8px 16px",
            borderRadius: 10,
            border: "none",
            background: "var(--gr)",
            color: "#06251a",
            fontSize: 13,
            fontWeight: 700,
            cursor: "pointer",
            fontFamily: "var(--font)",
          }}
        >
          Try again
        </button>
        <button
          type="button"
          onClick={() => window.location.reload()}
          style={{
            padding: "8px 16px",
            borderRadius: 10,
            background: "var(--card-2)",
            border: "1px solid var(--line-2)",
            color: "var(--tx-2)",
            fontSize: 13,
            fontWeight: 600,
            cursor: "pointer",
            fontFamily: "var(--font)",
          }}
        >
          Reload
        </button>
      </div>
    </div>
  );
}
