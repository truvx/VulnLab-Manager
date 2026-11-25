// QEMU block-driver names used for the imported source disk.
export type DiskFormat = 'vmdk' | 'qcow' | 'qcow2' | 'raw' | 'vdi' | 'vhdx' | 'vpc';
export type MachineStatus = 'stopped' | 'running' | 'error';

export interface MachineRecord {
  id: string;
  name: string;
  archiveName: string;
  rootDir: string;
  diskPath: string;
  diskFormat: DiskFormat;
  ovfPath?: string;
  architecture: 'x86_64' | 'i386';
  memoryMiB: number;
  importedAt: string;
  status: MachineStatus;
}

export interface AppState {
  machines: MachineRecord[];
  activeMachineId: string | null;
  labRoot: string;
  system: {
    platform: string;
    hostArch: string;
    qemuX86: boolean;
    qemuImg: boolean;
    qemuI386: boolean;
    qemuBundled: boolean;
    qemuVersion: string | null;
  };
}
