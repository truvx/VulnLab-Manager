// QEMU block-driver names used for the imported source disk.
export type DiskFormat = 'vmdk' | 'qcow' | 'qcow2' | 'raw' | 'vdi' | 'vhdx' | 'vpc';
export type MachineStatus = 'stopped' | 'running' | 'error';
export type NetworkMode = 'nat' | 'bridged';
export type PortForwardProtocol = 'tcp' | 'udp';

export interface PortForwardRule {
  id: string;
  protocol: PortForwardProtocol;
  hostPort: number;
  guestPort: number;
}

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
  networkMode?: NetworkMode;
  networkAdapter?: string;
  portForwards?: PortForwardRule[];
  macAddress?: string;
  ipAddress?: string | null;
}

export interface NetworkTrafficStats {
  captureAvailable: boolean;
  rxPackets: number;
  txPackets: number;
  rxBytes: number;
  txBytes: number;
  lastActivityAt: string | null;
  peerAddresses: string[];
}

export interface AppState {
  machines: MachineRecord[];
  activeMachineId: string | null;
  trafficStats: NetworkTrafficStats;
  trafficMachineId: string | null;
  labRoot: string;
  system: {
    platform: string;
    hostArch: string;
    qemuX86: boolean;
    qemuImg: boolean;
    qemuI386: boolean;
    qemuBundled: boolean;
    qemuVersion: string | null;
    hostIPv4Addresses: string[];
    networkInterfaceNames: string[];
    tapDevices: string[];
    bridgeAdapters: string[];
    vmnetSocketClientAvailable: boolean;
    vmnetBridgedSockets: string[];
  };
}
