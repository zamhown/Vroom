import { installErrorHandlers, setDiagnosticSink } from './diagnostics';
import { call } from './api';
import { notifyError } from './context';
import { TabBoundary } from './TabBoundary';
import { isInputTarget } from './ContextMenu';
import { createRoot } from 'react-dom/client';
import { useSyncExternalStore } from 'react';
import { getLocale, languageVersion, subscribeLanguage } from './i18n';
import App from './App';
import { Provider, ToastContainer } from '@react-spectrum/s2';
import '@react-spectrum/s2/page.css';
import { ConfirmationHost } from './ui';
import { spectrumTheme } from './theme';
import './styles.css';
import { trackUiWindow } from './window-environment';
trackUiWindow(window);
setDiagnosticSink(record => call('diagnostics.write', record));
installErrorHandlers(notifyError);
document.addEventListener(
  'contextmenu',
  event => {
    if (!isInputTarget(event.target)) event.preventDefault();
  },
  true,
);
document.documentElement.classList.add(...spectrumTheme.trim().split(/\s+/).filter(Boolean));
function Root() {
  useSyncExternalStore(subscribeLanguage, languageVersion);
  return (
    <Provider locale={getLocale()} colorScheme="dark" UNSAFE_className="spectrum-root">
      <TabBoundary>
        <App />
      </TabBoundary>
      <ConfirmationHost />
      <ToastContainer placement="bottom end" />
    </Provider>
  );
}
createRoot(document.getElementById('root')!).render(<Root />);
