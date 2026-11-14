import { createContext, useContext, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

// undefined means a standalone surface; null means its page host is mounting.
export const PageToolbarContext = createContext<HTMLDivElement | null | undefined>(undefined);

/** Keep commands in the nearest page's fixed area without moving the editor or its state. */
export function PageToolbar({ children }: { children: ReactNode }) {
  const host = useContext(PageToolbarContext);
  if (host === undefined) return children;
  return host ? createPortal(children, host) : null;
}
