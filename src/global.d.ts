import type { AppState, MachineRecord } from '../electron/types';

declare global {
  interface Window {
    lab: {
      getState: () => Promise<AppState>;
      selectArchive: () => Promise<string | null>;
      getPathForFile: (file: File) => string;
      importArchive: (path: string) => Promise<MachineRecord>;
      startMachine: (id: string, architecture: 'x86_64' | 'i386', memoryMiB: number) => Promise<{ ok: boolean; pid?: number }>;
      stopMachine: () => Promise<{ ok: boolean; message?: string }>;
      openNetworkSetupFiles: () => Promise<{ ok: boolean }>;
      removeMachine: (id: string) => Promise<{ ok: boolean }>;
      openLabFolder: () => Promise<void>;
      onLog: (callback: (message: string) => void) => () => void;
    };
  }
}
export {};
