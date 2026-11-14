import { createContext, useContext } from 'react';

// React state stays with its owning tab, while DOM events and overlays belong to their OS window.
export const WindowDocumentContext = createContext<Document | null>(null);
export const useWindowDocument = () => useContext(WindowDocumentContext) ?? document;
let active: Window | undefined;
export const activeUiWindow = () => (active && !active.closed ? active : window);
export function trackUiWindow(view: Window) {
  const remember = () => {
    active = view;
  };
  view.addEventListener('focus', remember);
  view.document.addEventListener('pointerdown', remember, true);
  view.document.addEventListener('keydown', remember, true);
  return () => {
    view.removeEventListener('focus', remember);
    view.document.removeEventListener('pointerdown', remember, true);
    view.document.removeEventListener('keydown', remember, true);
    if (active === view) active = undefined;
  };
}
