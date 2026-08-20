import { Component, type ErrorInfo, type ReactNode } from 'react'

type Props = { children: ReactNode }
type State = { message: string | null }

export class ErrorBoundary extends Component<Props, State> {
  state: State = { message: null }

  static getDerivedStateFromError(error: Error): State {
    return { message: error.message || '页面出错了' }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(error, info.componentStack)
  }

  render() {
    if (this.state.message) {
      return (
        <main className="task-list-empty">
          <h2>工作区暂时无法打开</h2>
          <p>{this.state.message}</p>
          <button type="button" className="button button-primary" onClick={() => window.location.reload()}>
            重新打开
          </button>
        </main>
      )
    }
    return this.props.children
  }
}
