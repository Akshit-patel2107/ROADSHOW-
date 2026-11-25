import React from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

interface ErrorBoundaryState {
  hasError: boolean;
  message: string;
  details?: string;
}

export class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  ErrorBoundaryState
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, message: '' };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    try {
      const parsed = JSON.parse(error.message);
      if (parsed?.operationType && parsed?.error) {
        return {
          hasError: true,
          message: `Database permission or connectivity error during ${parsed.operationType} on ${parsed.path || 'workspace'}.`,
          details: parsed.error,
        };
      }
    } catch {
      // Standard error
    }
    return {
      hasError: true,
      message: error.message || 'An unexpected rendering error occurred.',
    };
  }

  componentDidCatch(error: Error) {
    console.error('ROADSHADOW ErrorBoundary caught error:', error);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-[#071426] text-[#F5F8FC] flex items-center justify-center p-6">
          <div className="max-w-lg w-full bg-[#122943] border border-[#233B56] rounded-lg p-6 space-y-4">
            <div className="flex items-center gap-3 text-[#E5484D]">
              <AlertTriangle className="w-6 h-6 shrink-0" />
              <h1 className="text-lg font-semibold text-[#F5F8FC]">
                ROADSHADOW Application Recovery
              </h1>
            </div>
            <p className="text-sm text-[#A9B8CA] leading-relaxed">{this.state.message}</p>
            {this.state.details && (
              <pre className="text-xs font-mono bg-[#071426] border border-[#233B56] rounded p-3 text-[#A9B8CA] overflow-x-auto">
                {this.state.details}
              </pre>
            )}
            <button
              type="button"
              onClick={() => {
                this.setState({ hasError: false, message: '', details: undefined });
                window.location.reload();
              }}
              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium bg-[#2585FF] hover:bg-[#1C74E8] text-white rounded-md transition-colors"
            >
              <RefreshCw className="w-4 h-4" />
              Reload Application
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
