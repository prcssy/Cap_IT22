import { createContext, useState } from 'react';

export const SidebarContext = createContext();

export function SidebarProvider({ children }) {
  const [panelOpen, setPanelOpen] = useState(false);

  const openSidebar = () => {
    setPanelOpen(true);
  };

  const closeSidebar = () => {
    setPanelOpen(false);
  };

  const toggleSidebar = () => {
    setPanelOpen((prev) => !prev);
  };

  return (
    <SidebarContext.Provider value={{ panelOpen, setPanelOpen, openSidebar, closeSidebar, toggleSidebar }}>
      {children}
    </SidebarContext.Provider>
  );
}