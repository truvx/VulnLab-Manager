import { contextBridge, ipcRenderer, webUtils } from 'electron';

contextBridge.exposeInMainWorld('lab', {
  getState: () => ipcRenderer.invoke('lab:get-state'),
  selectArchive: () => ipcRenderer.invoke('lab:select-archive'),
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  importArchive: (path: string) => ipcRenderer.invoke('lab:import-archive', path),
  startMachine: (id: string, architecture: 'x86_64' | 'i386', memoryMiB: number) =>
    ipcRenderer.invoke('lab:start-machine', { id, architecture, memoryMiB }),
  stopMachine: () => ipcRenderer.invoke('lab:stop-machine'),
  saveNetworkConfig: (id: string, config: { networkMode: 'nat' | 'bridged'; networkAdapter: string; portForwards: Array<{ id: string; protocol: 'tcp' | 'udp'; hostPort: number; guestPort: number }> }) =>
    ipcRenderer.invoke('lab:save-network-config', id, config),
  openNetworkSetupFiles: () => ipcRenderer.invoke('lab:open-network-setup-files'),
  removeMachine: (id: string) => ipcRenderer.invoke('lab:remove-machine', id),
  openLabFolder: () => ipcRenderer.invoke('lab:open-lab-folder'),
  onLog: (callback: (message: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, message: string) => callback(message);
    ipcRenderer.on('lab:log', listener);
    return () => ipcRenderer.removeListener('lab:log', listener);
  }
});
