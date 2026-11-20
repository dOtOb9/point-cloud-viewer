import { Component, type ReactNode } from "react";

interface Props {
  pluginId: string;
  onError: (pluginId: string, error: unknown) => void;
  children: ReactNode;
}

interface State {
  failed: boolean;
}

export class PluginErrorBoundary extends Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: unknown): void {
    this.props.onError(this.props.pluginId, error);
  }

  render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}
