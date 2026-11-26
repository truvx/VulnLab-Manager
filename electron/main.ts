import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { spawn, execFile, ChildProcess, type ExecFileOptionsWithStringEncoding } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { constants as fsConstants, existsSync } from 'node:fs';
import crypto from 'node:crypto';
import yauzl from 'yauzl';
import { pipeline } from 'node:stream/promises';
import { XMLParser } from 'fast-xml-parser';
import * as tar from 'tar';
import type { AppState, DiskFormat, MachineRecord, NetworkMode, PortForwardRule, NetworkTrafficStats } from './types';

const execFileAsync = promisify(execFile);
const NAT_GUEST_IP = '10.77.0.15';
const NAT_SUBNET = '10.77.0.0/24';

function defaultPortForwards(): PortForwardRule[] {
  return [
    { id: 'ssh', protocol: 'tcp', hostPort: 2222, guestPort: 22 },
    { id: 'http', protocol: 'tcp', hostPort: 8080, guestPort: 80 },
    { id: 'https', protocol: 'tcp', hostPort: 8443, guestPort: 443 },
    { id: 'smb', protocol: 'tcp', hostPort: 1445, guestPort: 445 },
    { id: 'mysql', protocol: 'tcp', hostPort: 13306, guestPort: 3306 }
  ];
}

function machineMac(id: string): string {
  const digest = crypto.createHash('sha256').update(id).digest();
  return [0x52, 0x54, 0x00, digest[0], digest[1], digest[2]]
    .map((value) => value.toString(16).padStart(2, '0')).join(':');
}

function normalizeMachines(value: unknown): MachineRecord[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const machine = item as MachineRecord;
    return {
      ...machine,
      networkMode: machine.networkMode === 'bridged' ? 'bridged' : 'nat',
      networkAdapter: typeof machine.networkAdapter === 'string' ? machine.networkAdapter : '',
      portForwards: Array.isArray(machine.portForwards) ? machine.portForwards : defaultPortForwards(),
      macAddress: machine.macAddress || machineMac(machine.id)
    };
  });
}
const MAX_ENTRIES = 100_000;
const MAX_UNCOMPRESSED_BYTES = 100 * 1024 * 1024 * 1024;
const MAX_SINGLE_FILE_BYTES = 90 * 1024 * 1024 * 1024;

let mainWindow: BrowserWindow | null = null;
let targetProcess: ChildProcess | null = null;
let activeMachineId: string | null = null;
let trafficMachineId: string | null = null;
let activeCapturePath: string | null = null;
let captureReadOffset = 0;
let captureByteOrder: 'le' | 'be' | null = null;
let captureLinkType: number | null = null;
let trafficStats: NetworkTrafficStats = emptyTrafficStats();
let trafficCleanupPromise: Promise<void> = Promise.resolve();
let trafficPollPromise: Promise<void> | null = null;
let cachedHostNetworkInfo: HostNetworkInfo | null = null;
let cachedHostNetworkInfoAt = 0;
let targetLog = '';

function emptyTrafficStats(): NetworkTrafficStats {
  return {
    captureAvailable: false,
    rxPackets: 0,
    txPackets: 0,
    rxBytes: 0,
    txBytes: 0,
    lastActivityAt: null,
    guestIpAddress: null,
    peerAddresses: []
  };
}

function log(message: string) {
  const line = `[${new Date().toLocaleTimeString()}] ${message}`;
  targetLog = `${targetLog}\n${line}`.slice(-20_000);
  mainWindow?.webContents.send('lab:log', line);
  console.log(line);
}

function getLabRoot() {
  // New imports use the generic product folder; migrate registered legacy folders on startup.
  return path.join(os.homedir(), 'VulnLab');
}

function dbPath() {
  return path.join(app.getPath('userData'), 'machines.json');
}

async function readMachines(): Promise<MachineRecord[]> {
  try {
    const raw = await fs.readFile(dbPath(), 'utf8');
    const parsed = normalizeMachines(JSON.parse(raw));
    return parsed;
  } catch {
    // Product/package branding changed in 0.3.0. Recover the previous database
    // from common macOS Electron userData folder names instead of showing an empty library.
    const appData = app.getPath('appData');
    const legacyDbPaths = [
      path.join(appData, 'VulnHub Lab Manager', 'machines.json'),
      path.join(appData, 'vulnhub-lab-manager', 'machines.json'),
      path.join(appData, 'VulnHubLabManager', 'machines.json')
    ];
    for (const legacyPath of legacyDbPaths) {
      try {
        const raw = await fs.readFile(legacyPath, 'utf8');
        const parsed = normalizeMachines(JSON.parse(raw));
        if (parsed.length || Array.isArray(JSON.parse(raw))) {
          await writeMachines(parsed);
          log(`Recovered the existing machine library from ${path.dirname(legacyPath)}.`);
          return parsed;
        }
      } catch {
        // Try the next legacy application-data path.
      }
    }
    return [];
  }
}

async function writeMachines(machines: MachineRecord[]) {
  await fs.mkdir(path.dirname(dbPath()), { recursive: true });
  const temp = `${dbPath()}.tmp`;
  await fs.writeFile(temp, JSON.stringify(machines, null, 2), { mode: 0o600 });
  await fs.rename(temp, dbPath());
}

async function pathExists(target: string): Promise<boolean> {
  try { await fs.access(target); return true; } catch { return false; }
}

async function migrateLegacyLabRoot() {
  const legacyRoot = path.join(os.homedir(), 'VulnHubLab');
  const currentRoot = getLabRoot();
  if (!(await pathExists(legacyRoot))) {
    await fs.mkdir(path.join(currentRoot, 'machines'), { recursive: true });
    return;
  }
  const machines = await readMachines();
  if (!(await pathExists(currentRoot))) {
    await fs.rename(legacyRoot, currentRoot);
    const migrated = machines.map((machine) => ({
      ...machine,
      rootDir: machine.rootDir.startsWith(legacyRoot + path.sep) ? path.join(currentRoot, path.relative(legacyRoot, machine.rootDir)) : machine.rootDir,
      diskPath: machine.diskPath.startsWith(legacyRoot + path.sep) ? path.join(currentRoot, path.relative(legacyRoot, machine.diskPath)) : machine.diskPath,
      ovfPath: machine.ovfPath?.startsWith(legacyRoot + path.sep) ? path.join(currentRoot, path.relative(legacyRoot, machine.ovfPath)) : machine.ovfPath
    }));
    await writeMachines(migrated);
    log('Migrated the previous VulnHubLab storage folder to VulnLab.');
    return;
  }

  // If both roots exist, move each registered machine independently when its destination is free.
  let changed = false;
  const migrated = [] as MachineRecord[];
  for (const machine of machines) {
    if (!machine.rootDir.startsWith(legacyRoot + path.sep) || !(await pathExists(machine.rootDir))) {
      migrated.push(machine);
      continue;
    }
    const nextRootDir = path.join(currentRoot, path.relative(legacyRoot, machine.rootDir));
    if (await pathExists(nextRootDir)) {
      migrated.push(machine);
      continue;
    }
    await fs.mkdir(path.dirname(nextRootDir), { recursive: true });
    await fs.rename(machine.rootDir, nextRootDir);
    const move = (value?: string) => value?.startsWith(legacyRoot + path.sep) ? path.join(currentRoot, path.relative(legacyRoot, value)) : value;
    migrated.push({ ...machine, rootDir: nextRootDir, diskPath: move(machine.diskPath)!, ovfPath: move(machine.ovfPath) });
    changed = true;
  }
  if (changed) await writeMachines(migrated);
  await fs.mkdir(path.join(currentRoot, 'machines'), { recursive: true });
  log('Checked legacy machine folders for migration into VulnLab.');
}

function bundledQemuRoot() {
  const base = app.isPackaged ? process.resourcesPath : app.getAppPath();
  return path.join(base, app.isPackaged ? 'qemu' : 'runtime', ...(app.isPackaged ? [] : ['qemu']));
}

function bundledQemuBinDir() {
  return path.join(bundledQemuRoot(), 'bin');
}

function bundledQemuDataDir() {
  return path.join(bundledQemuRoot(), 'share', 'qemu');
}

async function isFile(candidate: string) {
  try { return (await fs.stat(candidate)).isFile(); } catch { return false; }
}

function qemuRuntimeEnvironment() {
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: hostPath() };
  const runtimeRoot = bundledQemuRoot();
  const moduleDir = path.join(runtimeRoot, 'lib', 'qemu');
  if (process.platform === 'darwin') {
    const libraryDir = path.join(runtimeRoot, 'lib');
    env.DYLD_LIBRARY_PATH = [libraryDir, process.env.DYLD_LIBRARY_PATH].filter(Boolean).join(path.delimiter);
  }
  if (process.platform === 'win32') {
    env.PATH = [bundledQemuBinDir(), process.env.PATH].filter(Boolean).join(path.delimiter);
  }
  if (existsSync(moduleDir)) {
    env.QEMU_MODULE_DIR = moduleDir;
  }
  return env;
}

function hostPath() {
  // GUI-launched applications do not always inherit the user's interactive shell PATH.
  const additions = process.platform === 'darwin'
    ? ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', '/usr/local/sbin', '/usr/bin', '/bin', '/usr/sbin', '/sbin']
    : process.platform === 'win32'
      ? [path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'qemu'), 'C:\\msys64\\clangarm64\\bin', 'C:\\msys64\\ucrt64\\bin']
      : ['/usr/local/bin', '/usr/local/sbin', '/usr/bin', '/usr/sbin', '/bin', '/sbin', '/snap/bin'];
  return [...new Set([bundledQemuBinDir(), ...additions, ...(process.env.PATH ?? '').split(path.delimiter).filter(Boolean)])].join(path.delimiter);
}

async function resolveCommand(command: string): Promise<string | null> {
  const extensions = process.platform === 'win32' && !/\.(exe|cmd|bat)$/i.test(command) ? ['', '.exe', '.cmd', '.bat'] : [''];
  const names = extensions.map((extension) => `${command}${extension}`);
  const check = async (candidate: string) => {
    try {
      const stat = await fs.stat(candidate);
      if (!stat.isFile()) return false;
      await fs.access(candidate, process.platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK);
      return true;
    } catch { return false; }
  };
  if (path.isAbsolute(command) || command.includes(path.sep)) {
    for (const name of names) if (await check(name)) return name;
    return null;
  }
  const known: Record<string, string[]> = process.platform === 'darwin' ? {
    'qemu-system-x86_64': ['/opt/homebrew/bin/qemu-system-x86_64', '/usr/local/bin/qemu-system-x86_64'],
    'qemu-system-i386': ['/opt/homebrew/bin/qemu-system-i386', '/usr/local/bin/qemu-system-i386'],
    'qemu-img': ['/opt/homebrew/bin/qemu-img', '/usr/local/bin/qemu-img'],
    'socket_vmnet_client': [
      '/opt/homebrew/opt/socket_vmnet/bin/socket_vmnet_client',
      '/opt/local/bin/socket_vmnet_client',
      '/opt/socket_vmnet/bin/socket_vmnet_client'
    ]
  } : process.platform === 'win32' ? {
    'qemu-system-x86_64': [path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'qemu', 'qemu-system-x86_64.exe')],
    'qemu-system-i386': [path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'qemu', 'qemu-system-i386.exe')],
    'qemu-img': [path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'qemu', 'qemu-img.exe')]
  } : {};
  const candidates = [
    ...names.map((name) => path.join(bundledQemuBinDir(), name)),
    ...(known[command] ?? []),
    ...hostPath().split(path.delimiter).flatMap((dir) => names.map((name) => path.join(dir, name)))
  ];
  for (const candidate of candidates) if (await check(candidate)) return candidate;
  return null;
}

async function listTarEntries(archivePath: string): Promise<string[]> {
  const tarExecutable = await resolveCommand('tar');
  if (!tarExecutable) throw new Error('A tar utility is required to inspect this archive. On Windows, use a recent Windows build with tar.exe available in PATH.');
  const listed = await execFileAsync(tarExecutable, ['-tf', archivePath], { maxBuffer: 20 * 1024 * 1024, encoding: 'utf8' });
  return listed.stdout.split(/\r?\n/).filter(Boolean);
}

async function commandExists(command: string): Promise<boolean> {
  return (await resolveCommand(command)) !== null;
}

async function runTool(command: string, args: string[], options: ExecFileOptionsWithStringEncoding = {}) {
  const executable = await resolveCommand(command);
  if (!executable) throw new Error(`${command} was not found. Install it and restart VulnLab Manager.`);
  return execFileAsync(executable, args, {
    encoding: 'utf8',
    ...options,
    env: qemuRuntimeEnvironment()
  });
}

function socketVmnetSocketCandidates(adapter: string): string[] {
  const prefix = process.env.HOMEBREW_PREFIX || '/opt/homebrew';
  return [
    path.join(prefix, 'var', 'run', `socket_vmnet.bridged.${adapter}`),
    path.join('/opt/local/var/run', `socket_vmnet.bridged.${adapter}`),
    path.join('/var/run', `socket_vmnet.bridged.${adapter}`)
  ];
}

async function discoverWindowsTapAdapters(): Promise<string[]> {
  if (process.platform !== 'win32') return [];
  const powershell = await resolveCommand('powershell.exe');
  if (!powershell) return [];
  try {
    const command = "Get-NetAdapter -IncludeHidden | Where-Object { $_.InterfaceDescription -match 'TAP-Windows|OpenVPN TAP' } | Select-Object -ExpandProperty Name";
    const result = await execFileAsync(powershell, ['-NoProfile', '-NonInteractive', '-Command', command], {
      encoding: 'utf8',
      timeout: 5000,
      maxBuffer: 1024 * 1024
    });
    return [...new Set(result.stdout.split(/\\r?\\n/).map((value) => value.trim()).filter(Boolean))];
  } catch (error) {
    log(`Windows TAP adapter discovery warning: ${String(error)}`);
    return [];
  }
}

interface HostNetworkInfo {
  hostIPv4Addresses: string[];
  networkInterfaceNames: string[];
  tapDevices: string[];
  bridgeAdapters: string[];
  vmnetSocketClientAvailable: boolean;
  vmnetBridgedSockets: string[];
}

async function getHostNetworkInfo(): Promise<HostNetworkInfo> {
  if (cachedHostNetworkInfo && Date.now() - cachedHostNetworkInfoAt < 15_000) return cachedHostNetworkInfo;
  const interfaces = os.networkInterfaces();
  const hostIPv4Addresses = [...new Set(Object.values(interfaces).flatMap((items) =>
    (items ?? []).filter((item) => item.family === 'IPv4' && !item.internal).map((item) => item.address)
  ))];
  const networkInterfaceNames = Object.keys(interfaces).filter((name) => name !== 'lo' && name !== 'lo0');
  let tapDevices: string[] = [];
  let bridgeAdapters: string[] = [];
  if (process.platform === 'darwin') {
    // socket_vmnet bridges QEMU to the selected macOS physical interface without
    // requiring the QEMU process itself to run as root.
    bridgeAdapters = networkInterfaceNames.filter((name) => name.startsWith('en') && name.length > 2 && [...name.slice(2)].every((digit) => digit >= '0' && digit <= '9')).sort();
  } else if (process.platform === 'win32') {
    tapDevices = await discoverWindowsTapAdapters();
    bridgeAdapters = tapDevices;
  }
  const vmnetSocketClientAvailable = process.platform === 'darwin'
    ? !!(await resolveCommand('socket_vmnet_client'))
    : false;
  const vmnetBridgedSockets = process.platform === 'darwin'
    ? (await Promise.all(bridgeAdapters.flatMap((adapter) => socketVmnetSocketCandidates(adapter))
      .map(async (candidate) => await pathExists(candidate) ? candidate : null))).filter((item): item is string => !!item)
    : [];
  cachedHostNetworkInfo = { hostIPv4Addresses, networkInterfaceNames, tapDevices, bridgeAdapters, vmnetSocketClientAvailable, vmnetBridgedSockets };
  cachedHostNetworkInfoAt = Date.now();
  return cachedHostNetworkInfo;
}

async function resolveGuestIpByMac(macAddress: string): Promise<string | null> {
  try {
    const arp = await resolveCommand('arp');
    if (!arp) return null;
    const args = process.platform === 'win32' ? ['-a'] : ['-an'];
    const { stdout } = await execFileAsync(arp, args, { encoding: 'utf8', timeout: 2500 });
    const wanted = macAddress.toLowerCase().replace(/[:-]/g, '');
    for (const line of stdout.split(/\\r?\\n/)) {
      if (line.toLowerCase().replace(/[:-]/g, '').includes(wanted)) {
        const ip = line.match(/\\b(?:\\d{1,3}\\.){3}\\d{1,3}\\b/)?.[0];
        if (ip && ip !== '0.0.0.0') return ip;
      }
    }
  } catch {
    // ARP discovery is best-effort; bridged guests may not have exchanged traffic yet.
  }
  return null;
}

function validatePortForwards(rules: PortForwardRule[]): PortForwardRule[] {
  if (!Array.isArray(rules) || rules.length > 32) {
    throw new Error('Use between 0 and 32 port-forwarding rules.');
  }
  const used = new Set<string>();
  return rules.map((rule) => {
    const protocol = rule.protocol === 'udp' ? 'udp' : rule.protocol === 'tcp' ? 'tcp' : null;
    const hostPort = Number(rule.hostPort);
    const guestPort = Number(rule.guestPort);
    if (!protocol || !Number.isInteger(hostPort) || hostPort < 1024 || hostPort > 65535 ||
        !Number.isInteger(guestPort) || guestPort < 1 || guestPort > 65535) {
      throw new Error('Port forwards require TCP/UDP, host ports 1024–65535, and guest ports 1–65535.');
    }
    const key = `${protocol}:${hostPort}`;
    if (used.has(key)) throw new Error(`Duplicate host port: ${protocol.toUpperCase()} ${hostPort}.`);
    used.add(key);
    return { id: String(rule.id || crypto.randomUUID()), protocol, hostPort, guestPort };
  });
}

async function saveNetworkConfig(id: string, config: {
  networkMode: NetworkMode;
  networkAdapter: string;
  portForwards: PortForwardRule[];
}) {
  if (config.networkMode !== 'nat' && config.networkMode !== 'bridged') {
    throw new Error('Unsupported network mode.');
  }
  const adapter = String(config.networkAdapter ?? '').trim();
  if (config.networkMode === 'bridged' && !adapter) {
    throw new Error('Enter the host TAP adapter name before saving bridged networking.');
  }
  if (adapter.includes(',')) throw new Error('TAP adapter names cannot contain commas.');
  const portForwards = validatePortForwards(config.portForwards ?? []);
  const machines = await readMachines();
  if (!machines.some((item) => item.id === id)) throw new Error('Machine not found.');
  await writeMachines(machines.map((item) => item.id === id
    ? { ...item, networkMode: config.networkMode, networkAdapter: adapter, portForwards }
    : item));
  log(`Saved ${config.networkMode.toUpperCase()} networking for ${machines.find((item) => item.id === id)?.name}.`);
  return { ok: true };
}

async function getSystemInfo() {
  const [qemuX86, qemuImg, qemuI386, qemuExecutable] = await Promise.all([
    commandExists('qemu-system-x86_64'), commandExists('qemu-img'), commandExists('qemu-system-i386'), resolveCommand('qemu-system-x86_64')
  ]);
  let qemuVersion: string | null = null;
  if (qemuExecutable) {
    try {
      const { stdout } = await execFileAsync(qemuExecutable, ['--version'], { encoding: 'utf8', timeout: 5000, env: qemuRuntimeEnvironment() });
      qemuVersion = stdout.split(/\r?\n/)[0]?.trim() ?? null;
    } catch (error) {
      log(`QEMU version check warning: ${String(error)}`);
    }
  }
  const bundledRoot = path.resolve(bundledQemuRoot()) + path.sep;
  const qemuBundled = !!qemuExecutable && path.resolve(qemuExecutable).startsWith(bundledRoot);
  const network = await getHostNetworkInfo();
  return { platform: process.platform, hostArch: process.arch, qemuX86, qemuImg, qemuI386, qemuBundled, qemuVersion, ...network };
}

function safeArchivePath(entryName: string): string | null {
  if (!entryName || entryName.includes('\0')) return null;
  const normalized = entryName.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) return null;
  const parts = normalized.split('/');
  if (parts.some((part) => part === '..')) return null;
  const cleaned = path.posix.normalize(normalized).replace(/^\.\//, '');
  if (!cleaned || cleaned === '.') return '.';
  return cleaned;
}

async function extractZipSafe(zipPath: string, destination: string) {
  await fs.mkdir(destination, { recursive: true });
  await new Promise<void>((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, decodeStrings: true, validateEntrySizes: true }, (openError, zip) => {
      if (openError || !zip) return reject(openError ?? new Error('Could not open ZIP archive'));
      let entryCount = 0;
      let totalBytes = 0;
      let finished = false;
      const fail = (error: Error) => {
        if (finished) return;
        finished = true;
        zip.close();
        reject(error);
      };
      zip.on('error', fail);
      zip.on('end', () => {
        if (finished) return;
        finished = true;
        resolve();
      });
      zip.on('entry', (entry) => {
        void (async () => {
          entryCount += 1;
          totalBytes += entry.uncompressedSize;
          if (entryCount > MAX_ENTRIES) throw new Error('Archive contains too many entries (limit: 100,000).');
          if (entry.uncompressedSize > MAX_SINGLE_FILE_BYTES || totalBytes > MAX_UNCOMPRESSED_BYTES) {
            throw new Error('Archive exceeds the extraction size safety limit (100 GiB total).');
          }
          const relative = safeArchivePath(entry.fileName);
          if (!relative) throw new Error(`Unsafe archive path rejected: ${entry.fileName}`);
          if (relative === '.') { zip.readEntry(); return; }
          const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
          const fileType = unixMode & 0o170000;
          if (fileType === 0o120000) throw new Error(`Symbolic link rejected in archive: ${entry.fileName}`);
          if (relative.startsWith('__MACOSX/')) {
            zip.readEntry();
            return;
          }
          const fullPath = path.resolve(destination, ...relative.split('/'));
          const root = path.resolve(destination) + path.sep;
          if (!fullPath.startsWith(root)) throw new Error(`Archive path escaped extraction folder: ${entry.fileName}`);
          if (entry.fileName.endsWith('/')) {
            await fs.mkdir(fullPath, { recursive: true });
            zip.readEntry();
            return;
          }
          await fs.mkdir(path.dirname(fullPath), { recursive: true });
          zip.openReadStream(entry, (streamError, readStream) => {
            if (streamError || !readStream) return fail(streamError ?? new Error('Could not read ZIP entry'));
            const writeStream = require('node:fs').createWriteStream(fullPath, { flags: 'wx', mode: 0o600 });
            pipeline(readStream, writeStream)
              .then(() => zip.readEntry())
              .catch((error) => fail(error instanceof Error ? error : new Error(String(error))));
          });
        })().catch((error) => fail(error instanceof Error ? error : new Error(String(error))));
      });
      zip.readEntry();
    });
  });
}

async function extractOvaSafe(ovaPath: string, destination: string) {
  await fs.mkdir(destination, { recursive: true });
  const entries = await listTarEntries(ovaPath);
  if (entries.length > MAX_ENTRIES) throw new Error('OVA contains too many entries.');
  for (const name of entries) {
    if (!safeArchivePath(name)) throw new Error(`Unsafe OVA path rejected: ${name}`);
  }
  await tar.x({ file: ovaPath, cwd: destination, strict: true, preservePaths: false,
    filter: (entryPath, entry) => {
      const safe = safeArchivePath(entryPath);
      if (!safe || safe === '.') return false;

      // tar v7 types the filter entry as Stats | ReadEntry. Only ReadEntry
      // exposes `type`; Stats exposes isSymbolicLink(). Narrow both forms.
      const entryType = 'type' in entry ? entry.type : undefined;
      const symbolicLinkFromType = entryType === 'SymbolicLink' || entryType === 'Link';
      const symbolicLinkFromStats =
        'isSymbolicLink' in entry &&
        typeof entry.isSymbolicLink === 'function' &&
        entry.isSymbolicLink();
      if (symbolicLinkFromType || symbolicLinkFromStats) return false;
      return true;
    }
  });
}

async function walkFiles(root: string): Promise<string[]> {
  const result: string[] = [];
  const pending = [root];
  while (pending.length) {
    const current = pending.pop()!;
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === '__MACOSX' || entry.name === '.DS_Store') continue;
      const full = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) pending.push(full);
      else if (entry.isFile()) result.push(full);
    }
  }
  return result;
}

function recursivelyFindValues(node: unknown, keyName: string, out: unknown[] = []): unknown[] {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const item of node) recursivelyFindValues(item, keyName, out);
    return out;
  }
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key.toLowerCase().replace(/^.*:/, '') === keyName.toLowerCase()) {
      if (Array.isArray(value)) out.push(...value);
      else out.push(value);
    }
    recursivelyFindValues(value, keyName, out);
  }
  return out;
}

function readAttr(node: unknown, attr: string): string | undefined {
  if (!node || typeof node !== 'object') return undefined;
  const obj = node as Record<string, unknown>;
  const value = obj[`@_${attr}`] ?? obj[`@_${attr.toLowerCase()}`];
  return typeof value === 'string' || typeof value === 'number' ? String(value) : undefined;
}

async function findOvfDisk(ovfPath: string, files: string[]): Promise<string | undefined> {
  try {
    const xml = await fs.readFile(ovfPath, 'utf8');
    const parsed = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', removeNSPrefix: true }).parse(xml);
    const refs = recursivelyFindValues(parsed, 'File');
    const disks = recursivelyFindValues(parsed, 'Disk');
    const idToHref = new Map<string, string>();
    for (const item of refs) {
      const id = readAttr(item, 'id');
      const href = readAttr(item, 'href');
      if (id && href) idToHref.set(id, href);
    }
    for (const disk of disks) {
      const fileRef = readAttr(disk, 'fileRef');
      if (fileRef && idToHref.has(fileRef)) {
        const href = idToHref.get(fileRef)!;
        const found = files.find((file) => path.resolve(file) === path.resolve(path.dirname(ovfPath), href));
        if (found) return found;
      }
    }
    const allHrefs = [...idToHref.values()];
    for (const href of allHrefs) {
      const found = files.find((file) => path.resolve(file) === path.resolve(path.dirname(ovfPath), href));
      if (found && /\.(vmdk|qcow|qcow2|vdi|vhd|vhdx|img|raw|vpc)$/i.test(found)) return found;
    }
  } catch (error) {
    log(`OVF disk reference parsing warning: ${String(error)}`);
  }
  return undefined;
}

function detectFormat(filePath: string): DiskFormat | null {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.vmdk')) return 'vmdk';
  if (lower.endsWith('.qcow2')) return 'qcow2';
  if (lower.endsWith('.qcow')) return 'qcow';
  if (lower.endsWith('.img') || lower.endsWith('.raw')) return 'raw';
  if (lower.endsWith('.vdi')) return 'vdi';
  if (lower.endsWith('.vhdx')) return 'vhdx';
  // QEMU calls the VHD/VPC block format "vpc".
  if (lower.endsWith('.vhd') || lower.endsWith('.vpc')) return 'vpc';
  return null;
}

function displayNameFromSource(sourcePath: string) {
  const base = path.basename(sourcePath).replace(/\.(zip|ova|ovf|vbox|tar|tgz|tar\.gz|vmdk|qcow2?|img|raw|vdi|vhdx?|vpc)$/i, '');
  return base.replace(/[_-]+/g, ' ').trim() || 'Imported machine';
}

async function copyDirectorySafe(source: string, destination: string) {
  await fs.mkdir(destination, { recursive: true });
  const entries = await fs.readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === '__MACOSX' || entry.name === '.DS_Store') continue;
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Symbolic link rejected in imported VM folder: ${from}`);
    if (entry.isDirectory()) await copyDirectorySafe(from, to);
    else if (entry.isFile()) {
      await fs.mkdir(path.dirname(to), { recursive: true });
      await fs.copyFile(from, to, fsConstants.COPYFILE_EXCL);
    }
  }
}

async function extractTarSafe(archivePath: string, destination: string) {
  await fs.mkdir(destination, { recursive: true });
  const entries = await listTarEntries(archivePath);
  if (entries.length > MAX_ENTRIES) throw new Error('Tar archive contains too many entries.');
  for (const name of entries) {
    if (!safeArchivePath(name)) throw new Error(`Unsafe tar path rejected: ${name}`);
  }
  await tar.x({ file: archivePath, cwd: destination, strict: true, preservePaths: false,
    filter: (entryPath, entry) => {
      const safe = safeArchivePath(entryPath);
      if (!safe || safe === '.') return false;
      const entryType = 'type' in entry ? entry.type : undefined;
      const symbolicLinkFromType = entryType === 'SymbolicLink' || entryType === 'Link';
      const symbolicLinkFromStats = 'isSymbolicLink' in entry && typeof entry.isSymbolicLink === 'function' && entry.isSymbolicLink();
      return !symbolicLinkFromType && !symbolicLinkFromStats;
    }
  });
}

async function findVBoxDisk(vboxPath: string, files: string[]): Promise<string | undefined> {
  try {
    const xml = await fs.readFile(vboxPath, 'utf8');
    const parsed = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', removeNSPrefix: true }).parse(xml);
    const hardDisks = recursivelyFindValues(parsed, 'HardDisk');
    const uuidToLocation = new Map<string, string>();
    for (const disk of hardDisks) {
      const uuid = readAttr(disk, 'uuid');
      const location = readAttr(disk, 'location');
      if (uuid && location) uuidToLocation.set(uuid.replace(/[{}]/g, '').toLowerCase(), location);
    }
    const images = recursivelyFindValues(parsed, 'Image');
    for (const image of images) {
      const uuid = readAttr(image, 'uuid')?.replace(/[{}]/g, '').toLowerCase();
      const location = uuid ? uuidToLocation.get(uuid) : undefined;
      if (!location) continue;
      const found = files.find((file) => path.resolve(file) === path.resolve(path.dirname(vboxPath), location));
      if (found && detectFormat(found)) return found;
    }
    for (const location of uuidToLocation.values()) {
      const found = files.find((file) => path.resolve(file) === path.resolve(path.dirname(vboxPath), location));
      if (found && detectFormat(found)) return found;
    }
  } catch (error) {
    log(`VirtualBox metadata parsing warning: ${String(error)}`);
  }
  return undefined;
}

async function importMachineSource(sourcePath: string): Promise<MachineRecord> {
  const stat = await fs.stat(sourcePath);
  const isDirectory = stat.isDirectory();
  if (!isDirectory && !stat.isFile()) throw new Error('Selected source must be a regular file or VM folder.');
  const lower = sourcePath.toLowerCase();
  const isZip = !isDirectory && lower.endsWith('.zip');
  const isTar = !isDirectory && (lower.endsWith('.ova') || lower.endsWith('.tar') || lower.endsWith('.tar.gz') || lower.endsWith('.tgz'));
  const isDescriptor = !isDirectory && (lower.endsWith('.ovf') || lower.endsWith('.vbox'));
  const directDiskFormat = !isDirectory ? detectFormat(sourcePath) : null;
  if (!isDirectory && !isZip && !isTar && !isDescriptor && !directDiskFormat) {
    throw new Error('Unsupported source. Import ZIP/OVA/TAR archives, a VM folder or OVF/VBox descriptor, or a VMDK/QCOW/VDI/VHD/VHDX/IMG/RAW disk image.');
  }
  const root = getLabRoot();
  await fs.mkdir(path.join(root, 'machines'), { recursive: true });
  const id = crypto.randomUUID();
  const safeName = displayNameFromSource(sourcePath).replace(/[^a-zA-Z0-9._ -]/g, '').slice(0, 64) || 'machine';
  const machineRoot = path.join(root, 'machines', `${safeName}-${id.slice(0, 8)}`);
  await fs.mkdir(machineRoot, { recursive: true });
  log(`Importing ${path.basename(sourcePath)}...`);
  try {
    if (isDirectory) {
      await copyDirectorySafe(sourcePath, machineRoot);
    } else if (isDescriptor) {
      // An OVF/VBox descriptor references sibling disk and config files. Import its containing folder.
      await copyDirectorySafe(path.dirname(sourcePath), machineRoot);
    } else if (isZip) {
      await extractZipSafe(sourcePath, machineRoot);
    } else if (isTar) {
      await extractTarSafe(sourcePath, machineRoot);
    } else if (directDiskFormat) {
      await fs.copyFile(sourcePath, path.join(machineRoot, path.basename(sourcePath)));
    }
    let files = await walkFiles(machineRoot);
    const nestedArchives = files.filter((file) => {
      const item = file.toLowerCase();
      return item.endsWith('.ova') || item.endsWith('.tar') || item.endsWith('.tar.gz') || item.endsWith('.tgz') || item.endsWith('.zip');
    });
    for (const nested of nestedArchives) {
      const nestedLower = nested.toLowerCase();
      const unpacked = path.join(path.dirname(nested), `${path.basename(nested).replace(/\.(ova|tar|tar\.gz|tgz|zip)$/i, '')}-unpacked`);
      if (nestedLower.endsWith('.zip')) await extractZipSafe(nested, unpacked);
      else await extractTarSafe(nested, unpacked);
    }
    files = await walkFiles(machineRoot);
    const ovfs = files.filter((file) => file.toLowerCase().endsWith('.ovf'));
    const vboxFiles = files.filter((file) => file.toLowerCase().endsWith('.vbox'));
    const disks = files.filter((file) => detectFormat(file) !== null && !/-flat\.vmdk$/i.test(file));
    if (!disks.length) throw new Error('No supported virtual disk found. Supported formats: VMDK, QCOW/QCOW2, VDI, VHD/VHDX, IMG, RAW and VPC.');
    let selectedDisk: string | undefined;
    let selectedOvf: string | undefined;
    for (const ovf of ovfs) {
      selectedDisk = await findOvfDisk(ovf, disks);
      if (selectedDisk) { selectedOvf = ovf; break; }
    }
    if (!selectedDisk) {
      for (const vbox of vboxFiles) {
        selectedDisk = await findVBoxDisk(vbox, disks);
        if (selectedDisk) break;
      }
    }
    if (!selectedDisk && disks.length === 1) selectedDisk = disks[0];
    if (!selectedDisk) throw new Error(`Found ${disks.length} possible disks but could not determine the boot disk. Include OVF/VirtualBox metadata or import a folder with only the intended boot disk.`);
    const diskFormat = detectFormat(selectedDisk)!;
    const machine: MachineRecord = {
      id,
      name: displayNameFromSource(sourcePath),
      archiveName: path.basename(sourcePath),
      rootDir: machineRoot,
      diskPath: selectedDisk,
      diskFormat,
      ovfPath: selectedOvf,
      architecture: 'x86_64',
      memoryMiB: 1024,
      importedAt: new Date().toISOString(),
      status: 'stopped',
      networkMode: 'nat',
      networkAdapter: '',
      portForwards: defaultPortForwards(),
      macAddress: machineMac(id)
    };
    const all = await readMachines();
    all.unshift(machine);
    await writeMachines(all);
    log(`Imported ${machine.name}; selected ${path.basename(selectedDisk)} (${diskFormat}).`);
    return machine;
  } catch (error) {
    log(`Import failed: ${String(error)}`);
    // Keep extracted files for inspection/recovery, but do not register a broken VM.
    throw error;
  }
}

function qemuBinary(architecture: 'x86_64' | 'i386') {
  return architecture === 'i386' ? 'qemu-system-i386' : 'qemu-system-x86_64';
}

async function buildNetworkArguments(machine: MachineRecord): Promise<string[]> {
  const mode = machine.networkMode ?? 'nat';
  const mac = machine.macAddress || machineMac(machine.id);
  if (mode === 'bridged') {
    const adapter = (machine.networkAdapter ?? '').trim();
    if (!adapter) throw new Error('Choose a host network adapter in Machine configuration before starting this bridged target.');
    if (process.platform === 'darwin') {
      if (!adapter.startsWith('en') || adapter.length < 3 || ![...adapter.slice(2)].every((digit) => digit >= '0' && digit <= '9')) throw new Error('On macOS, choose a physical network interface such as en0 or en1.');
      // socket_vmnet_client passes an already-connected socket to QEMU on fd 3.
      // The launcher wrapper is selected in startMachine after the socket is validated.
      return ['-netdev', 'socket,id=labnet,fd=3', '-device', `e1000,netdev=labnet,mac=${mac}`];
    }
    if (process.platform === 'win32') {
      const knownTapAdapters = await discoverWindowsTapAdapters();
      if (!knownTapAdapters.includes(adapter)) {
        throw new Error(`TAP adapter "${adapter}" was not found by Windows. Install the ARM64 TAP-Windows NDIS 6.30 driver, then select its adapter name from the detected list.`);
      }
      return ['-netdev', `tap,id=labnet,ifname=${adapter}`, '-device', `e1000,netdev=labnet,mac=${mac}`];
    }
    throw new Error('Bridged networking is not configured for this host platform.');
  }

  const rules = validatePortForwards(machine.portForwards ?? defaultPortForwards());
  const forwardArgs = rules.map((rule) =>
    `hostfwd=${rule.protocol}:0.0.0.0:${rule.hostPort}-${NAT_GUEST_IP}:${rule.guestPort}`
  );
  const backend = [
    'user',
    'id=labnet',
    `net=${NAT_SUBNET}`,
    `dhcpstart=${NAT_GUEST_IP}`,
    ...forwardArgs
  ].join(',');
  return ['-netdev', backend, '-device', `e1000,netdev=labnet,mac=${mac}`];
}

async function resolveBridgedLauncher(machine: MachineRecord, qemuExecutable: string): Promise<{ executable: string; prefixArgs: string[] }> {
  if ((machine.networkMode ?? 'nat') !== 'bridged' || process.platform !== 'darwin') {
    return { executable: qemuExecutable, prefixArgs: [] };
  }

  const adapter = (machine.networkAdapter ?? '').trim();
  const client = await resolveCommand('socket_vmnet_client');
  if (!client) {
    throw new Error('macOS bridged networking requires socket_vmnet. Install it with "brew install socket_vmnet", then configure its bridged LaunchDaemon for the selected interface. See the macOS Bridged setup guide.');
  }
  const socketPath = socketVmnetSocketCandidates(adapter).find((candidate) => existsSync(candidate));
  if (!socketPath) {
    throw new Error(`No socket_vmnet bridge is running for ${adapter}. Configure and start the socket_vmnet LaunchDaemon for ${adapter}; expected socket: ${socketVmnetSocketCandidates(adapter)[0]}.`);
  }
  return { executable: client, prefixArgs: [socketPath, qemuExecutable] };
}

function bytesToIPv4(buffer: Buffer, offset: number): string {
  return [buffer[offset], buffer[offset + 1], buffer[offset + 2], buffer[offset + 3]].join('.');
}

function bytesToIPv6(buffer: Buffer, offset: number): string {
  return Array.from({ length: 8 }, (_, index) => buffer.readUInt16BE(offset + index * 2).toString(16)).join(':');
}

function addTrafficPacket(packet: Buffer, originalLength: number, guestMac: string) {
  if (packet.length < 14) return;
  const normalizedMac = guestMac.toLowerCase().replace(/[^a-f0-9]/g, '');
  const sourceMac = packet.subarray(6, 12).toString('hex');
  const destinationMac = packet.subarray(0, 6).toString('hex');
  const outgoing = sourceMac === normalizedMac;
  const incoming = destinationMac === normalizedMac;
  if (!outgoing && !incoming) return;

  if (outgoing) {
    trafficStats.txPackets += 1;
    trafficStats.txBytes += originalLength;
  } else {
    trafficStats.rxPackets += 1;
    trafficStats.rxBytes += originalLength;
  }

  let peer: string | null = null;
  const etherType = packet.readUInt16BE(12);
  if (etherType === 0x0800 && packet.length >= 34) {
    peer = outgoing ? bytesToIPv4(packet, 30) : bytesToIPv4(packet, 26);
    if (outgoing) {
      const guestAddress = bytesToIPv4(packet, 26);
      if (guestAddress !== '0.0.0.0') trafficStats.guestIpAddress = guestAddress;
    }
  } else if (etherType === 0x86dd && packet.length >= 54) {
    peer = outgoing ? bytesToIPv6(packet, 38) : bytesToIPv6(packet, 22);
  } else if (etherType === 0x0806 && packet.length >= 42) {
    peer = outgoing ? bytesToIPv4(packet, 38) : bytesToIPv4(packet, 28);
    if (outgoing) {
      const guestAddress = bytesToIPv4(packet, 28);
      if (guestAddress !== '0.0.0.0') trafficStats.guestIpAddress = guestAddress;
    }
  }

  if (peer && peer !== '0.0.0.0' && peer !== '255.255.255.255' && peer !== '::') {
    trafficStats.peerAddresses = [peer, ...trafficStats.peerAddresses.filter((item) => item !== peer)].slice(0, 6);
  }
  trafficStats.lastActivityAt = new Date().toISOString();
  trafficStats.captureAvailable = true;
}

async function pollTrafficCaptureInternal() {
  if (!activeCapturePath) return;
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    handle = await fs.open(activeCapturePath, 'r');
    const stat = await handle.stat();
    if (stat.size < 24) return;

    if (!captureByteOrder || captureLinkType === null) {
      const header = Buffer.alloc(24);
      const read = await handle.read(header, 0, header.length, 0);
      if (read.bytesRead < 24) return;
      const magic = header.readUInt32LE(0);
      if (magic === 0xa1b2c3d4 || magic === 0xa1b23c4d) captureByteOrder = 'le';
      else if (header.readUInt32BE(0) === 0xa1b2c3d4 || header.readUInt32BE(0) === 0xa1b23c4d) captureByteOrder = 'be';
      else return;
      captureLinkType = captureByteOrder === 'le' ? header.readUInt32LE(20) : header.readUInt32BE(20);
      if (captureLinkType !== 1) return; // Ethernet link type only.
      captureReadOffset = 24;
      trafficStats.captureAvailable = true;
    }

    const remaining = Math.min(Math.max(0, stat.size - captureReadOffset), 2 * 1024 * 1024);
    if (remaining < 16) return;
    const chunk = Buffer.alloc(remaining);
    const read = await handle.read(chunk, 0, remaining, captureReadOffset);
    const data = chunk.subarray(0, read.bytesRead);
    let cursor = 0;
    const readUInt32 = (offset: number) => captureByteOrder === 'le' ? data.readUInt32LE(offset) : data.readUInt32BE(offset);
    while (cursor + 16 <= data.length) {
      const capturedLength = readUInt32(cursor + 8);
      const originalLength = readUInt32(cursor + 12);
      if (capturedLength > 65535 || cursor + 16 + capturedLength > data.length) break;
      addTrafficPacket(data.subarray(cursor + 16, cursor + 16 + capturedLength), originalLength, activeGuestMac);
      cursor += 16 + capturedLength;
    }
    captureReadOffset += cursor;
  } catch {
    // Capture files may not exist yet or may be removed as QEMU exits.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function pollTrafficCapture(): Promise<void> {
  if (trafficPollPromise) return trafficPollPromise;
  trafficPollPromise = pollTrafficCaptureInternal().finally(() => { trafficPollPromise = null; });
  return trafficPollPromise;
}

let activeGuestMac = '52:54:00:00:00:00';

async function finishTrafficCapture() {
  await pollTrafficCapture();
  const capturePath = activeCapturePath;
  activeCapturePath = null;
  if (capturePath) await fs.rm(capturePath, { force: true }).catch(() => undefined);
}

async function startMachine(id: string, architecture: 'x86_64' | 'i386', memoryMiB: number) {
  if (targetProcess && !targetProcess.killed) throw new Error('A QEMU target is already running. Stop it before starting another target.');
  await trafficCleanupPromise;
  const machines = await readMachines();
  const machine = machines.find((item) => item.id === id);
  if (!machine) throw new Error('Machine not found in the library.');
  if (!(await commandExists(qemuBinary(architecture)))) throw new Error(`Could not find ${qemuBinary(architecture)} in PATH.`);
  if (!Number.isInteger(memoryMiB) || memoryMiB < 256 || memoryMiB > 8192) throw new Error('Memory must be between 256 and 8192 MiB.');
  if (!(await commandExists('qemu-img'))) throw new Error('qemu-img was not found. It is required to create a disposable QCOW2 overlay so the imported base disk remains unchanged.');
  const snapshotDir = path.join(machine.rootDir, 'snapshots');
  await fs.mkdir(snapshotDir, { recursive: true });
  const overlayPath = path.join(snapshotDir, `run-${new Date().toISOString().replace(/[:.]/g, '-')}.qcow2`);
  await runTool('qemu-img', ['create', '-f', 'qcow2', '-F', machine.diskFormat, '-b', machine.diskPath, overlayPath]);
  log(`Created disposable write overlay: ${overlayPath}`);
  const qemuDiskPath = process.platform === 'win32' ? overlayPath.replace(/\\/g, '/') : overlayPath;
  const capturePath = path.join(snapshotDir, `network-${new Date().toISOString().replace(/[:.]/g, '-')}.pcap`);
  const qemuArgs = [
    ...(existsSync(bundledQemuDataDir()) ? ['-L', bundledQemuDataDir()] : []),
    '-machine', 'pc', '-accel', 'tcg', '-cpu', 'max', '-smp', '1', '-m', String(memoryMiB),
    '-name', machine.name,
    '-drive', `file=${qemuDiskPath},format=qcow2,if=ide,index=0`,
    '-boot', 'order=c,menu=on',
    ...await buildNetworkArguments(machine),
    '-object', `filter-dump,id=networktrace,netdev=labnet,file=${capturePath.replace(/\\/g, '/')},maxlen=54`,
    '-display', process.platform === 'darwin' ? 'cocoa' : process.platform === 'win32' ? 'sdl' : 'gtk',
    '-monitor', 'none', '-serial', 'none', '-parallel', 'none'
  ];
  log(`Starting ${machine.name} with ${qemuBinary(architecture)} (TCG emulation, ${memoryMiB} MiB RAM).`);
  log(`QEMU disk: ${machine.diskPath}`);
  const qemuExecutable = await resolveCommand(qemuBinary(architecture));
  if (!qemuExecutable) throw new Error(`${qemuBinary(architecture)} was not found. Install QEMU and restart the app.`);
  const launcher = await resolveBridgedLauncher(machine, qemuExecutable);
  activeCapturePath = capturePath;
  captureReadOffset = 0;
  captureByteOrder = null;
  captureLinkType = null;
  activeGuestMac = machine.macAddress || machineMac(machine.id);
  trafficMachineId = machine.id;
  trafficStats = emptyTrafficStats();
  const child = spawn(launcher.executable, [...launcher.prefixArgs, ...qemuArgs], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: qemuRuntimeEnvironment()
  });
  targetProcess = child;
  activeMachineId = id;
  child.stdout?.on('data', (chunk: Buffer) => log(`QEMU: ${chunk.toString().trim()}`));
  child.stderr?.on('data', (chunk: Buffer) => log(`QEMU: ${chunk.toString().trim()}`));
  child.on('error', (error) => {
    const exitedId = activeMachineId;
    log(`QEMU launch error: ${error.message}`);
    trafficCleanupPromise = finishTrafficCapture();
    targetProcess = null;
    activeMachineId = null;
    if (exitedId) void readMachines().then((items) => writeMachines(items.map((item) => item.id === exitedId ? { ...item, status: 'stopped' as const } : item)));
  });
  child.on('exit', (code, signal) => {
    const exitedId = activeMachineId;
    log(`QEMU exited (code=${code ?? 'none'}, signal=${signal ?? 'none'}).`);
    trafficCleanupPromise = finishTrafficCapture();
    targetProcess = null;
    activeMachineId = null;
    if (exitedId) void readMachines().then((items) => writeMachines(items.map((item) => item.id === exitedId ? { ...item, status: 'stopped' as const } : item)));
  });
  await new Promise((resolve) => setTimeout(resolve, 800));
  if (child.exitCode !== null) throw new Error(`QEMU exited immediately with code ${child.exitCode}. Check the log panel.`);
  const updated = machines.map((item) => item.id === id ? { ...item, status: 'running' as const, architecture, memoryMiB } : item);
  await writeMachines(updated);
  return { ok: true, pid: child.pid };
}

async function stopMachine() {
  if (!targetProcess) return { ok: true, message: 'No QEMU target is running.' };
  const child = targetProcess;
  const stoppingId = activeMachineId;
  log('Stopping QEMU target...');
  child.kill('SIGTERM');
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      if (child.exitCode === null) child.kill('SIGKILL');
      resolve();
    }, 5000);
    child.once('exit', () => { clearTimeout(timeout); resolve(); });
  });
  await trafficCleanupPromise;
  const machines = await readMachines();
  await writeMachines(machines.map((item) => item.id === stoppingId ? { ...item, status: 'stopped' as const } : item));
  targetProcess = null;
  activeMachineId = null;
  return { ok: true };
}

async function revealNetworkSetupFiles() {
  const scriptPath = app.isPackaged
    ? path.join(process.resourcesPath, 'network-setup', 'lab-network-setup.sh')
    : path.join(__dirname, '..', 'lab-network-setup.sh');
  try {
    await fs.access(scriptPath);
  } catch {
    throw new Error(`Network setup script was not found: ${scriptPath}`);
  }
  const folderError = await shell.openPath(path.dirname(scriptPath));
  if (folderError) throw new Error(`Could not open network setup folder: ${folderError}`);
  log('Opened generic network setup files in Finder. Copy the optional Linux helper into your attacker VM manually; it is never run by the app.');
  return { ok: true };
}

async function removeMachine(id: string) {
  if (id === activeMachineId) throw new Error('Stop the active target before removing it.');
  const machines = await readMachines();
  const machine = machines.find((item) => item.id === id);
  if (!machine) return { ok: true };
  const updated = machines.filter((item) => item.id !== id);
  await writeMachines(updated);
  await fs.rm(machine.rootDir, { recursive: true, force: true });
  log(`Removed ${machine.name} and its extracted files.`);
  return { ok: true };
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180, height: 820, minWidth: 900, minHeight: 680,
    title: 'VulnLab Manager',
    backgroundColor: '#10151d',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  if (!app.isPackaged) await mainWindow.loadURL('http://127.0.0.1:5173');
  else await mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(async () => {
  await migrateLegacyLabRoot().catch((error) => log(`Storage migration warning: ${String(error)}`));
  ipcMain.handle('lab:get-state', async (): Promise<AppState> => {
    const machines = await readMachines();
    const displayedMachines = await Promise.all(machines.map(async (machine) => {
      let ipAddress: string | null = null;
      if (machine.id === activeMachineId) {
        ipAddress = (machine.networkMode ?? 'nat') === 'nat'
          ? NAT_GUEST_IP
          : (trafficMachineId === machine.id ? trafficStats.guestIpAddress : null)
            ?? await resolveGuestIpByMac(machine.macAddress || machineMac(machine.id));
      }
      return { ...machine, ipAddress };
    }));
    await pollTrafficCapture();
    return {
      machines: displayedMachines,
      activeMachineId,
      trafficStats,
      trafficMachineId,
      labRoot: getLabRoot(),
      system: await getSystemInfo()
    };
  });
  ipcMain.handle('lab:select-archive', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Import a vulnerable virtual machine',
      properties: ['openFile', 'openDirectory'],
      filters: [{ name: 'VM archives and disk images', extensions: ['zip', 'ova', 'tar', 'tgz', 'gz', 'vmdk', 'qcow', 'qcow2', 'vdi', 'vhd', 'vhdx', 'img', 'raw', 'vpc', 'ovf', 'vbox'] }]
    });
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.handle('lab:import-archive', async (_event, filePath: string) => importMachineSource(filePath));
  ipcMain.handle('lab:start-machine', async (_event, options) => startMachine(options.id, options.architecture, options.memoryMiB));
  ipcMain.handle('lab:stop-machine', stopMachine);
  ipcMain.handle('lab:save-network-config', async (_event, id, config) => saveNetworkConfig(id, config));
  ipcMain.handle('lab:open-network-setup-files', revealNetworkSetupFiles);
  ipcMain.handle('lab:remove-machine', async (_event, id: string) => removeMachine(id));
  ipcMain.handle('lab:open-lab-folder', async () => shell.openPath(getLabRoot()));
  await createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) void createWindow(); });
});

app.on('before-quit', () => {
  if (targetProcess && targetProcess.exitCode === null) targetProcess.kill('SIGTERM');
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
