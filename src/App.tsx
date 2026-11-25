import { useEffect, useMemo, useState } from 'react';
import type { AppState } from '../electron/types';

export default function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [architecture, setArchitecture] = useState<'x86_64' | 'i386'>('x86_64');
  const [memoryMiB, setMemoryMiB] = useState(1024);
  const [logs, setLogs] = useState<string[]>([]);
  const [notice, setNotice] = useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(null);
  const selectedMachine = useMemo(() => state?.machines.find((machine) => machine.id === selectedId) ?? null, [state, selectedId]);

  async function refresh() {
    const next = await window.lab.getState();
    setState(next);
    setSelectedId((current) => current && next.machines.some((machine) => machine.id === current) ? current : next.machines[0]?.id ?? null);
  }

  useEffect(() => {
    void refresh();
    const unsubscribe = window.lab.onLog((message) => setLogs((current) => [...current.slice(-99), message]));
    return unsubscribe;
  }, []);

  async function importPath(filePath: string) {
    if (!filePath) return;
    setBusy(true); setNotice(null);
    try {
      const machine = await window.lab.importArchive(filePath);
      await refresh(); setSelectedId(machine.id);
      setNotice({ type: 'success', text: `Imported ${machine.name}. Boot disk: ${machine.diskPath.split(/[\\/]/).pop()}` });
    } catch (error) {
      setNotice({ type: 'error', text: error instanceof Error ? error.message : String(error) });
    } finally { setBusy(false); }
  }

  async function chooseArchive() {
    const filePath = await window.lab.selectArchive();
    if (filePath) await importPath(filePath);
  }

  async function onDrop(event: React.DragEvent) {
    event.preventDefault(); setDragging(false);
    const file = event.dataTransfer.files[0];
    if (!file) return;
    const path = window.lab.getPathForFile(file);
    if (!path) { setNotice({ type: 'error', text: 'Could not read the dropped file path. Use Import archive instead.' }); return; }
    await importPath(path);
  }

  async function runAction(action: () => Promise<unknown>, successText: string) {
    setBusy(true); setNotice(null);
    try { await action(); await refresh(); setNotice({ type: 'success', text: successText }); }
    catch (error) { setNotice({ type: 'error', text: error instanceof Error ? error.message : String(error) }); }
    finally { setBusy(false); }
  }

  const system = state?.system;
  const hostPlatformLabel = system?.platform === 'darwin' ? 'macOS' : system?.platform === 'win32' ? 'Windows' : system?.platform === 'linux' ? 'Linux' : 'Host';
  const hostArchitectureLabel = system?.hostArch === 'arm64' ? 'ARM64' : system?.hostArch === 'x64' ? 'x64' : system?.hostArch ?? 'Detecting…';
  const checks = [
    { label: 'QEMU x86_64', ready: !!system?.qemuX86 },
    { label: 'QEMU i386', ready: !!system?.qemuI386 },
    { label: 'qemu-img', ready: !!system?.qemuImg }
  ];

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand-mark">V</div>
      <div className="brand-copy"><strong>VulnLab</strong><span>MACHINE MANAGER</span></div>
      <div className="side-section-label">WORKSPACE</div>
      <div className="nav-item active"><span className="nav-icon">▦</span> Machines</div>
      <div className="nav-item"><span className="nav-icon">⌁</span> Network lab</div>
      <div className="nav-item"><span className="nav-icon">≡</span> Activity log</div>
      <div className="sidebar-bottom">
        <div className="host-card"><span className="dot green"/> {hostPlatformLabel} <small>{hostArchitectureLabel}</small></div>
        <button className="text-button" onClick={() => void window.lab.openLabFolder()}>Open lab folder ↗</button>
      </div>
    </aside>

    <main className="main-content">
      <header className="topbar">
        <div><div className="eyebrow">LOCAL ENVIRONMENT</div><h1>Machines</h1></div>
        <div className="top-actions"><span className="host-pill"><span className="dot green"/> Local only</span><button className="primary-button" onClick={() => void chooseArchive()} disabled={busy}>＋ Import machine</button></div>
      </header>

      <section className="system-strip">
        {checks.map((check) => <div className="system-check" key={check.label}><span className={check.ready ? 'check-icon ready' : 'check-icon'}>{check.ready ? '✓' : '!'}</span><span>{check.label}</span><b>{check.ready ? 'Ready' : 'Missing'}</b></div>)}
      </section>

      {notice && <div className={`notice ${notice.type}`}><span>{notice.type === 'error' ? '⚠' : notice.type === 'success' ? '✓' : 'i'}</span>{notice.text}<button onClick={() => setNotice(null)}>×</button></div>}

      <section className={`drop-zone ${dragging ? 'dragging' : ''}`} onDragOver={(event) => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={onDrop}>
        <div className="drop-icon">⇧</div>
        <div className="drop-copy"><h2>Drop a VM package or disk image here</h2><p>ZIP/OVA/TAR, OVF/VBOX folders and VMDK/QCOW/VDI/VHDX/IMG/RAW · Any source</p></div>
        <button className="secondary-button" onClick={() => void chooseArchive()} disabled={busy}>Browse files</button>
        {busy && <div className="drop-progress"><span/></div>}
      </section>

      <div className="content-grid">
        <section className="panel machine-panel">
          <div className="panel-heading"><div><h2>Your machines</h2><p>{state?.machines.length ?? 0} imported machine{state?.machines.length === 1 ? '' : 's'}</p></div><span className="count-badge">{state?.machines.length ?? 0}</span></div>
          {!state?.machines.length ? <div className="empty-state"><div className="empty-glyph">▤</div><strong>No machines imported</strong><span>Import a vulnerable VM package, virtual disk, or machine folder to get started.</span></div> : <div className="machine-list">
            {state.machines.map((machine) => <button className={`machine-row ${selectedId === machine.id ? 'selected' : ''}`} key={machine.id} onClick={() => setSelectedId(machine.id)}>
              <div className="machine-icon">▣</div><div className="machine-meta"><strong>{machine.name}</strong><span>{machine.diskFormat.toUpperCase()} · {machine.architecture} · {new Date(machine.importedAt).toLocaleDateString()}</span></div><span className={`status ${machine.status}`}>{machine.status}</span>
            </button>)}
          </div>}
        </section>

        <section className="panel detail-panel">
          <div className="panel-heading"><div><h2>Machine configuration</h2><p>QEMU emulation settings</p></div><span className="gear">⚙</span></div>
          {selectedMachine ? <>
            <div className="target-summary"><div className="target-avatar">{selectedMachine.name.slice(0, 1).toUpperCase()}</div><div><strong>{selectedMachine.name}</strong><span>{selectedMachine.diskPath.split(/[\\/]/).pop()}</span></div></div>
            <label className="field-label" htmlFor="architecture">Guest architecture</label>
            <select id="architecture" value={architecture} onChange={(event) => setArchitecture(event.target.value as 'x86_64' | 'i386')}><option value="x86_64">x86_64 (64-bit / 32-bit guests)</option><option value="i386">i386 (32-bit emulator)</option></select>
            <label className="field-label" htmlFor="memory">Memory allocation</label>
            <div className="memory-control"><input id="memory" type="range" min="256" max="4096" step="256" value={memoryMiB} onChange={(event) => setMemoryMiB(Number(event.target.value))}/><strong>{memoryMiB >= 1024 ? `${(memoryMiB / 1024).toFixed(memoryMiB % 1024 ? 2 : 0)} GB` : `${memoryMiB} MB`}</strong></div>
            <div className="disk-info"><span>Disk format</span><b>{selectedMachine.diskFormat.toUpperCase()}</b><span>Boot method</span><b>BIOS · IDE</b><span>Network device</span><b>E1000 · UDP tunnel</b></div>
            {state?.activeMachineId ? <button className="danger-button full" disabled={busy} onClick={() => void runAction(() => window.lab.stopMachine(), 'Stopped the QEMU target. Your attacker VM was not changed.')}>■ Stop target</button> : <button className="primary-button full" disabled={busy || !system?.qemuImg || (architecture === 'x86_64' ? !system?.qemuX86 : !system?.qemuI386)} onClick={() => void runAction(() => window.lab.startMachine(selectedMachine.id, architecture, memoryMiB), `Started ${selectedMachine.name}. Start your preferred attacker VM manually.`)}>▶ Start target</button>}
            <button className="danger-button full" disabled={busy || selectedMachine.status === 'running'} onClick={() => void runAction(() => window.lab.removeMachine(selectedMachine.id), `Removed ${selectedMachine.name}.`)}>Remove machine and extracted files</button>
          </> : <div className="empty-detail">Select an imported machine to configure its QEMU launch.</div>}
        </section>
      </div>

      <section className="panel network-panel">
        <div className="panel-heading"><div><h2>Attacker network</h2><p>QEMU target ↔ your manually started attacker VM · localhost UDP tunnel</p></div><span className="network-badge"><span className="dot amber"/>Manual VM setup</span></div>
        <div className="network-flow"><div className="network-node"><div className="node-icon">⌘</div><div><strong>Attacker VM</strong><span>Kali, Parrot OS, or another compatible VM · start manually</span></div></div><div className="tunnel"><div className="tunnel-line"/><span>UDP 10001 ⇄ 10002</span></div><div className="network-node"><div className="node-icon target">▣</div><div><strong>QEMU target</strong><span>E1000 · dgram backend · launched by this app</span></div></div></div>
        <div className="network-actions"><button className="secondary-button" disabled={busy} onClick={() => void runAction(() => window.lab.openNetworkSetupFiles(), 'Opened the network setup files in Finder.')}>Show network setup files</button><div className="network-hint">The app only starts and stops the QEMU target. It never starts, stops, or changes another VM. Configure Adapter 2 on your chosen attacker VM as a Generic UDP Tunnel (host 127.0.0.1, source port 10001, destination port 10002). The included generic Linux helper is optional. It asks you to select the isolated guest interface and refuses to modify the default internet interface.</div></div>
      </section>

      <section className="panel logs-panel"><div className="panel-heading"><div><h2>Activity</h2><p>Recent importer and QEMU events</p></div><button className="text-button" onClick={() => setLogs([])}>Clear</button></div><div className="log-view">{logs.length ? logs.slice(-8).map((line, index) => <div key={`${index}-${line}`}><span>{line.slice(0, 10)}</span>{line.slice(11)}</div>) : <span className="log-placeholder">No activity yet. Import an archive to begin.</span>}</div></section>
      <footer>VulnLab Manager · General-purpose local VM orchestration · Imported machine images are untrusted; inspect before booting.</footer>
    </main>
  </div>;
}
