import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "@vantyr/ui/components/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "@vantyr/ui/components/empty";

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
    <Empty role="alert" className="min-h-[280px] bg-card">
      <EmptyHeader>
        <EmptyTitle>Something went wrong</EmptyTitle>
        <EmptyDescription>
          This part of the dashboard hit an unexpected error. Your session is still active — you can retry or reload.
        </EmptyDescription>
      </EmptyHeader>
      <p className="max-w-[560px] font-mono text-xs text-muted-foreground/70 [overflow-wrap:anywhere]">
        {error.message}
      </p>
      <EmptyContent>
        <div className="flex gap-2">
          <Button onClick={onReset}>Try again</Button>
          <Button variant="outline" onClick={() => window.location.reload()}>
            Reload
          </Button>
        </div>
      </EmptyContent>
    </Empty>
  );
}
