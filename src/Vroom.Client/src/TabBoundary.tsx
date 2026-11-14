import { Component, type ErrorInfo, type ReactNode } from 'react';
import { t } from './i18n';
import { reportError } from './diagnostics';
import { Button } from './ui';

export class TabBoundary extends Component<
  { tabId?: string; children: ReactNode },
  { failed: boolean; attempt: number }
> {
  state = { failed: false, attempt: 0 };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    reportError(
      Object.assign(new Error(error.message), { stack: `${error.stack}\n${info.componentStack}` }),
      'client.render',
      this.props.tabId,
    );
  }
  render() {
    if (this.state.failed)
      return (
        <div className="boot-error" role="alert">
          <h2>{t('Stability.tabFailed')}</h2>
          <p>{t('Stability.tabRecovery')}</p>
          <Button onClick={() => this.setState(s => ({ failed: false, attempt: s.attempt + 1 }))}>
            {t('Stability.retryTab')}
          </Button>
        </div>
      );
    return (
      <div className="tab-runtime" key={this.state.attempt}>
        {this.props.children}
      </div>
    );
  }
}
