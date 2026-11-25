import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { spawn, execFile, ChildProcess, type ExecFileOptionsWithStringEncoding } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { constants as fsConstants } from 'node:fs';
import crypto from 'node:crypto';
import yauzl from 'yauzl';
import { pipeline } from 'node:stream/promises';
import { XMLParser } from 'fast-xml-parser';
import * as tar from 'tar';
import type { AppState, DiskFormat, MachineRecord } from './types';

const execFileAsync = promisify(execFile);
const UDP_LOCAL_PORT = 10002;
const UDP_REMOTE_PORT = 10001;
const MAX_ENTRIES = 100_000;
const MAX_UNCOMPRESSED_BYTES = 100 * 1024 * 1024 * 1024;
const MAX_SINGLE_FILE_BYTES = 90 * 1024 * 1024 * 1024;

let mainWindow: BrowserWindow | null = null;
let targetProcess: ChildProcess | null = null;
let activeMachineId: string | null = null;
let targetLog = '';

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
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
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
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          await writeMachines(parsed as MachineRecord[]);
          log(`Recovered the existing machine library from ${path.dirname(legacyPath)}.`);
          return parsed as MachineRecord[];
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

function hostPath() {
  // GUI-launched applications do not always inherit the user's interactive shell PATH.
  const additions = process.platform === 'darwin'
    ? ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', '/usr/local/sbin', '/usr/bin', '/bin', '/usr/sbin', '/sbin']
    : process.platform === 'win32'
      ? [path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'qemu'), 'C:\\msys64\\clangarm64\\bin', 'C:\\msys64\\ucrt64\\bin']
      : ['/usr/local/bin', '/usr/local/sbin', '/usr/bin', '/usr/sbin', '/bin', '/sbin', '/snap/bin'];
  return [...new Set([...additions, ...(process.env.PATH ?? '').split(path.delimiter).filter(Boolean)])].join(path.delimiter);
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
    'qemu-img': ['/opt/homebrew/bin/qemu-img', '/usr/local/bin/qemu-img']
  } : process.platform === 'win32' ? {
    'qemu-system-x86_64': [path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'qemu', 'qemu-system-x86_64.exe')],
    'qemu-system-i386': [path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'qemu', 'qemu-system-i386.exe')],
    'qemu-img': [path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'qemu', 'qemu-img.exe')]
  } : {};
  const candidates = [
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
    env: { ...process.env, PATH: hostPath() }
  });
}

async function getSystemInfo() {
  const [qemuX86, qemuImg, qemuI386] = await Promise.all([
    commandExists('qemu-system-x86_64'), commandExists('qemu-img'), commandExists('qemu-system-i386')
  ]);
  return { platform: process.platform, hostArch: process.arch, qemuX86, qemuImg, qemuI386 };
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
      status: 'stopped'
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

async function startMachine(id: string, architecture: 'x86_64' | 'i386', memoryMiB: number) {
  if (targetProcess && !targetProcess.killed) throw new Error('A QEMU target is already running. Stop it before starting another target.');
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
  const qemuArgs = [
    '-machine', 'pc', '-accel', 'tcg', '-cpu', 'max', '-smp', '1', '-m', String(memoryMiB),
    '-name', machine.name,
    '-drive', `file=${qemuDiskPath},format=qcow2,if=ide,index=0`,
    '-boot', 'order=c,menu=on',
    '-netdev', `dgram,id=labnet,local.type=inet,local.host=127.0.0.1,local.port=${UDP_LOCAL_PORT},remote.type=inet,remote.host=127.0.0.1,remote.port=${UDP_REMOTE_PORT}`,
    '-device', 'e1000,netdev=labnet',
    '-display', process.platform === 'darwin' ? 'cocoa' : process.platform === 'win32' ? 'sdl' : 'gtk',
    '-monitor', 'none', '-serial', 'none', '-parallel', 'none'
  ];
  log(`Starting ${machine.name} with ${qemuBinary(architecture)} (TCG emulation, ${memoryMiB} MiB RAM).`);
  log(`QEMU disk: ${machine.diskPath}`);
  const qemuExecutable = await resolveCommand(qemuBinary(architecture));
  if (!qemuExecutable) throw new Error(`${qemuBinary(architecture)} was not found. Install QEMU and restart the app.`);
  const child = spawn(qemuExecutable, qemuArgs, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PATH: hostPath() } });
  targetProcess = child;
  activeMachineId = id;
  child.stdout?.on('data', (chunk: Buffer) => log(`QEMU: ${chunk.toString().trim()}`));
  child.stderr?.on('data', (chunk: Buffer) => log(`QEMU: ${chunk.toString().trim()}`));
  child.on('error', (error) => {
    const exitedId = activeMachineId;
    log(`QEMU launch error: ${error.message}`);
    targetProcess = null;
    activeMachineId = null;
    if (exitedId) void readMachines().then((items) => writeMachines(items.map((item) => item.id === exitedId ? { ...item, status: 'stopped' as const } : item)));
  });
  child.on('exit', (code, signal) => {
    const exitedId = activeMachineId;
    log(`QEMU exited (code=${code ?? 'none'}, signal=${signal ?? 'none'}).`);
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
  ipcMain.handle('lab:get-state', async (): Promise<AppState> => ({
    machines: await readMachines(),
    activeMachineId,
    labRoot: getLabRoot(),
    system: await getSystemInfo()
  }));
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
