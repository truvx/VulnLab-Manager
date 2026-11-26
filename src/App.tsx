import { useEffect, useMemo, useState } from 'react';
import type { AppState, NetworkMode, PortForwardRule } from '../electron/types';

export default function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [architecture, setArchitecture] = useState<'x86_64' | 'i386'>('x86_64');
  const [memoryMiB, setMemoryMiB] = useState(1024);
  const [networkMode, setNetworkMode] = useState<NetworkMode>('nat');
  const [networkAdapter, setNetworkAdapter] = useState('');
  const [portForwards, setPortForwards] = useState<PortForwardRule[]>([]);
  const [networkDirty, setNetworkDirty] = useState(false);
  const [newProtocol, setNewProtocol] = useState<'tcp' | 'udp'>('tcp');
  const [newHostPort, setNewHostPort] = useState('18080');
  const [newGuestPort, setNewGuestPort] = useState('8080');
  const [logs, setLogs] = useState<string[]>([]);
  const [notice, setNotice] = useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(null);
  const selectedMachine = useMemo(() => state?.machines.find((machine) => machine.id === selectedId) ?? null, [state, selectedId]);

  useEffect(() => {
    if (!selectedMachine) return;
    setNetworkMode(selectedMachine.networkMode ?? 'nat');
    setNetworkAdapter(selectedMachine.networkAdapter ?? '');
    setPortForwards(selectedMachine.portForwards ?? []);
    setNetworkDirty(false);
  }, [selectedMachine?.id]);

  async function refresh() {
    const next = await window.lab.getState();
    setState(next);
    setSelectedId((current) => current && next.machines.some((machine) => machine.id === current) ? current : next.machines[0]?.id ?? null);
  }

  useEffect(() => {
    void refresh();
    const unsubscribe = window.lab.onLog((message) => setLogs((current) => [...current.slice(-99), message]));
    const refreshTimer = window.setInterval(() => { void refresh(); }, 3000);
    return () => {
      window.clearInterval(refreshTimer);
      unsubscribe();
    };
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

  async function saveNetworkSettings() {
    if (!selectedMachine) return;
    setBusy(true);
    setNotice(null);
    try {
      await window.lab.saveNetworkConfig(selectedMachine.id, { networkMode, networkAdapter, portForwards });
      await refresh();
      setNetworkDirty(false);
      setNotice({ type: 'success', text: 'Saved network settings. Restart the target to apply them.' });
    } catch (error) {
      setNotice({ type: 'error', text: error instanceof Error ? error.message : String(error) });
      setNetworkDirty(true);
    } finally {
      setBusy(false);
    }
  }

  function updatePortForward(id: string, patch: Partial<PortForwardRule>) {
    setPortForwards((current) => current.map((rule) => rule.id === id ? { ...rule, ...patch } : rule));
    setNetworkDirty(true);
  }

  function addPortForward() {
    const hostPort = Number(newHostPort);
    const guestPort = Number(newGuestPort);
    if (!Number.isInteger(hostPort) || hostPort < 1024 || hostPort > 65535 ||
        !Number.isInteger(guestPort) || guestPort < 1 || guestPort > 65535) {
      setNotice({ type: 'error', text: 'Use host ports 1024–65535 and guest ports 1–65535.' });
      return;
    }
    if (portForwards.some((rule) => rule.protocol === newProtocol && rule.hostPort === hostPort)) {
      setNotice({ type: 'error', text: 'That protocol and host port are already forwarded.' });
      return;
    }
    setPortForwards((current) => [...current, { id: `forward-${Date.now()}`, protocol: newProtocol, hostPort, guestPort }]);
    setNetworkDirty(true);
  }

  const system = state?.system;
  const hostPlatformLabel = system?.platform === 'darwin' ? 'macOS' : system?.platform === 'win32' ? 'Windows' : system?.platform === 'linux' ? 'Linux' : 'Host';
  const hostArchitectureLabel = system?.hostArch === 'arm64' ? 'ARM64' : system?.hostArch === 'x64' ? 'x64' : system?.hostArch ?? 'Detecting…';
  const checks = [
    { label: system?.qemuBundled ? `QEMU ${system.qemuVersion?.replace(/^QEMU emulator version /, '') ?? ''} · Bundled` : 'QEMU x86_64', ready: !!system?.qemuX86 },
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

      <div className="import-activity-grid">
        <section className={`drop-zone ${dragging ? 'dragging' : ''}`} onDragOver={(event) => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={onDrop}>
          <div className="drop-icon">⇧</div>
          <div className="drop-copy"><h2>Drop a VM package or disk image here</h2><p>ZIP/OVA/TAR, OVF/VBOX folders and VMDK/QCOW/VDI/VHDX/IMG/RAW · Any source</p></div>
          <button className="secondary-button" onClick={() => void chooseArchive()} disabled={busy}>Browse files</button>
          {busy && <div className="drop-progress"><span/></div>}
        </section>
        <section className="panel logs-panel logs-panel-compact">
          <div className="panel-heading"><div><h2>Activity</h2><p>Recent importer and QEMU events</p></div><button className="text-button" onClick={() => setLogs([])}>Clear</button></div>
          <div className="log-view">{logs.length ? logs.slice(-6).map((line, index) => <div key={`${index}-${line}`}><span>{line.slice(0, 10)}</span>{line.slice(11)}</div>) : <span className="log-placeholder">No activity yet. Import an archive to begin.</span>}</div>
        </section>
      </div>

      <div className="content-grid">
        <section className="panel machine-panel">
          <div className="panel-heading"><div><h2>Your machines</h2><p>{state?.machines.length ?? 0} imported machine{state?.machines.length === 1 ? '' : 's'}</p></div><span className="count-badge">{state?.machines.length ?? 0}</span></div>
          {!state?.machines.length ? <div className="empty-state"><div className="empty-glyph">▤</div><strong>No machines imported</strong><span>Import a vulnerable VM package, virtual disk, or machine folder to get started.</span></div> : <div className="machine-list">
            {state.machines.map((machine) => <button className={`machine-row ${selectedId === machine.id ? 'selected' : ''}`} key={machine.id} onClick={() => setSelectedId(machine.id)}>
              <div className="machine-icon">▣</div><div className="machine-meta"><strong>{machine.name}</strong><span>{machine.diskFormat.toUpperCase()} · {machine.architecture} · IP {machine.ipAddress ?? (machine.status === 'running' ? 'discovering…' : '—')}{machine.status === 'running' && machine.networkMode === 'nat' ? ' (expected)' : ''} · {new Date(machine.importedAt).toLocaleDateString()}</span></div><span className={`status ${machine.status}`}>{machine.status}</span>
            </button>)}
          </div>}
        </section>

        <section className="panel detail-panel">
          <div className="panel-heading"><div><h2>Machine configuration</h2><p>QEMU emulation settings</p></div><span className="gear">⚙</span></div>
          {selectedMachine ? <>
            <div className="target-summary"><div className="target-avatar">{selectedMachine.name.slice(0, 1).toUpperCase()}</div><div><strong>{selectedMachine.name}</strong><span>{selectedMachine.diskPath.split(/[\\/]/).pop()}</span><span className="guest-ip">{networkMode === 'nat' ? 'Expected guest IP: ' : 'Guest IP: '}{selectedMachine.ipAddress ?? (selectedMachine.status === 'running' ? 'waiting for DHCP/ARP' : 'not running')}</span></div></div>
            <label className="field-label" htmlFor="architecture">Guest architecture</label>
            <select id="architecture" value={architecture} onChange={(event) => setArchitecture(event.target.value as 'x86_64' | 'i386')}><option value="x86_64">x86_64 (64-bit / 32-bit guests)</option><option value="i386">i386 (32-bit emulator)</option></select>
            <label className="field-label" htmlFor="memory">Memory allocation</label>
            <div className="memory-control"><input id="memory" type="range" min="256" max="4096" step="256" value={memoryMiB} onChange={(event) => setMemoryMiB(Number(event.target.value))}/><strong>{memoryMiB >= 1024 ? `${(memoryMiB / 1024).toFixed(memoryMiB % 1024 ? 2 : 0)} GB` : `${memoryMiB} MB`}</strong></div>
            <div className="network-config">
              <label className="field-label" htmlFor="network-mode">Network mode</label>
              <select id="network-mode" value={networkMode} onChange={(event) => {
                const nextMode = event.target.value as NetworkMode;
                setNetworkMode(nextMode);
                if (nextMode === 'bridged' && !networkAdapter) setNetworkAdapter(system?.bridgeAdapters?.[0] ?? '');
                setNetworkDirty(true);
              }}>
                <option value="nat">NAT · attacker-accessible port forwards</option>
                <option value="bridged">Bridged · {system?.platform === 'darwin' ? 'socket_vmnet' : 'TAP adapter'}</option>
              </select>
              {networkMode === 'nat' ? <>
                <div className="network-help">
                  <strong>QEMU NAT · expected guest address 10.77.0.15</strong>
                  <span>Guest outbound traffic is NATed. Kali/Parrot reaches services through the host's forwarded ports below; this is not a Layer-2 scan of the guest subnet.</span>
                </div>
                <div className="forward-heading"><strong>Port forwarding</strong><span>Host port → guest port</span></div>
                <div className="forward-list">
                  {portForwards.map((rule) => <div className="forward-row" key={rule.id}>
                    <select aria-label="Protocol" value={rule.protocol} onChange={(event) => updatePortForward(rule.id, { protocol: event.target.value as 'tcp' | 'udp' })}>
                      <option value="tcp">TCP</option><option value="udp">UDP</option>
                    </select>
                    <input aria-label="Host port" type="number" min="1024" max="65535" value={rule.hostPort} onChange={(event) => updatePortForward(rule.id, { hostPort: Number(event.target.value) })}/>
                    <span>→</span>
                    <input aria-label="Guest port" type="number" min="1" max="65535" value={rule.guestPort} onChange={(event) => updatePortForward(rule.id, { guestPort: Number(event.target.value) })}/>
                    <button className="remove-forward" title="Remove port forward" onClick={() => { setPortForwards((current) => current.filter((item) => item.id !== rule.id)); setNetworkDirty(true); }}>×</button>
                  </div>)}
                  {!portForwards.length && <span className="forward-empty">No ports forwarded. Add a rule to make a guest service reachable from your attacker VM.</span>}
                </div>
                <div className="forward-add">
                  <select aria-label="New forward protocol" value={newProtocol} onChange={(event) => setNewProtocol(event.target.value as 'tcp' | 'udp')}><option value="tcp">TCP</option><option value="udp">UDP</option></select>
                  <input aria-label="New host port" type="number" min="1024" max="65535" value={newHostPort} onChange={(event) => setNewHostPort(event.target.value)} placeholder="Host port"/>
                  <span>→</span>
                  <input aria-label="New guest port" type="number" min="1" max="65535" value={newGuestPort} onChange={(event) => setNewGuestPort(event.target.value)} placeholder="Guest port"/>
                  <button className="secondary-button" onClick={addPortForward}>Add</button>
                </div>
                <div className="host-addresses">
                  <strong>Connect from attacker VM using a host IP:</strong>
                  <span>{system?.hostIPv4Addresses?.length ? system.hostIPv4Addresses.join(' · ') : 'No non-loopback host IPv4 detected'}</span>
                  <code>nmap -sV -Pn -p {portForwards.map((rule) => rule.hostPort).join(',') || '<host-ports>'} &lt;HOST-IP&gt;</code>
                  <strong>Kali inside VirtualBox · NAT adapter</strong>
                  <span>Use Kali's default gateway to reach the Mac host. With VirtualBox's default NAT this is normally 10.0.2.2; detect yours with the command below.</span>
                  <code>GW="$(ip route show default | cut -d' ' -f3 | head -n1)" && nmap -sV -Pn -p {portForwards.map((rule) => rule.hostPort).join(',') || '<host-ports>'} "$GW"</code>
                </div>
                <p className="network-warning">Forwarded ports bind to all host interfaces so a VM can reach them. Keep this target on a trusted, isolated network and remove forwards you do not need.</p>
              </> : <>
                <label className="field-label" htmlFor="tap-adapter">{system?.platform === 'darwin' ? 'Host network interface' : 'TAP adapter'}</label>
                <input id="tap-adapter" className="network-adapter-input" list="bridge-adapter-options" value={networkAdapter} onChange={(event) => { setNetworkAdapter(event.target.value); setNetworkDirty(true); }} placeholder={system?.platform === 'darwin' ? 'en0' : 'TAP-Windows Adapter V9'}/>
                <datalist id="bridge-adapter-options">
                  {(system?.bridgeAdapters ?? []).map((name) => <option key={name} value={name}/>)}
                </datalist>
                <div className="network-help">
                  <strong>{system?.platform === 'darwin' ? 'Layer-2 bridge via Apple vmnet + socket_vmnet' : 'Layer-2 bridge via Windows TAP'}</strong>
                  {system?.platform === 'darwin' ? <>
                    <span>Choose a physical interface such as en0. socket_vmnet_client: {system?.vmnetSocketClientAvailable ? 'detected' : 'not installed'}.</span>
                    <span>Active bridged vmnet sockets: {system?.vmnetBridgedSockets?.length ? system.vmnetBridgedSockets.join(', ') : 'none detected'}.</span>
                    <span>{networkAdapter && system?.vmnetBridgedSockets?.some((socket) => socket.endsWith(`socket_vmnet.bridged.${networkAdapter}`)) ? `Bridge for ${networkAdapter} is ready.` : `Bridge for ${networkAdapter || 'the selected interface'} is not ready yet.`}</span>
                    <span>Install with brew install socket_vmnet, then configure the socket_vmnet bridged LaunchDaemon for this interface. The app runs QEMU unprivileged through the helper; it does not install or launch root services.</span>
                  </> : <>
                    <span>Requires an ARM64-compatible TAP-Windows NDIS 6.30 driver (for example, the OpenVPN tap-windows6 driver). Enter the exact adapter name recognized by Windows.</span>
                    <span>Detected TAP adapters: {system?.tapDevices?.length ? system.tapDevices.join(', ') : 'none detected'}.</span>
                  </>}
                  <span>Connect the selected host interface and your attacker VM to the same isolated Layer-2 segment. Set VirtualBox Adapter 2 to Bridged on that same segment. Never bridge a deliberately vulnerable guest onto a public or trusted home/work LAN.</span>
                </div>
              </>}
              <button className="secondary-button full save-network" disabled={busy || !networkDirty || (networkMode === 'bridged' && !networkAdapter.trim())} onClick={() => void saveNetworkSettings()}>
                {networkDirty ? 'Save network settings' : 'Network settings saved'}
              </button>
            </div>
            <div className="disk-info"><span>Disk format</span><b>{selectedMachine.diskFormat.toUpperCase()}</b><span>Boot method</span><b>BIOS · IDE</b><span>Network device</span><b>{networkMode === 'nat' ? 'E1000 · QEMU user NAT' : system?.platform === 'darwin' ? 'E1000 · socket_vmnet bridge' : 'E1000 · TAP bridge'}</b></div>
            {state?.activeMachineId ? <button className="danger-button full" disabled={busy} onClick={() => void runAction(() => window.lab.stopMachine(), 'Stopped the QEMU target. Your attacker VM was not changed.')}>■ Stop target</button> : <button className="primary-button full" disabled={busy || networkDirty || !system?.qemuImg || (architecture === 'x86_64' ? !system?.qemuX86 : !system?.qemuI386)} onClick={() => void runAction(() => window.lab.startMachine(selectedMachine.id, architecture, memoryMiB), `Started ${selectedMachine.name}. Start your preferred attacker VM manually.`)}>▶ Start target</button>}
            <button className="danger-button full" disabled={busy || selectedMachine.status === 'running'} onClick={() => void runAction(() => window.lab.removeMachine(selectedMachine.id), `Removed ${selectedMachine.name}.`)}>Remove machine and extracted files</button>
          </> : <div className="empty-detail">Select an imported machine to configure its QEMU launch.</div>}
        </section>
      </div>

      <section className="panel traffic-panel">
        <div className="panel-heading">
          <div><h2>Live network activity</h2><p>{selectedMachine ? selectedMachine.name : 'Select a target'} · QEMU NIC packet telemetry</p></div>
          <span className={state?.activeMachineId === selectedMachine?.id && selectedMachine ? 'traffic-state active' : 'traffic-state'}>{state?.activeMachineId === selectedMachine?.id && selectedMachine ? 'MONITORING' : state?.trafficMachineId === selectedMachine?.id && selectedMachine ? 'LAST RUN' : 'IDLE'}</span>
        </div>
        {selectedMachine && state?.trafficMachineId === selectedMachine.id ? <>
          <div className="traffic-metrics">
            <div><span>Received</span><strong>{state.trafficStats.rxPackets.toLocaleString()}</strong><small>{state.trafficStats.rxBytes.toLocaleString()} bytes</small></div>
            <div><span>Sent</span><strong>{state.trafficStats.txPackets.toLocaleString()}</strong><small>{state.trafficStats.txBytes.toLocaleString()} bytes</small></div>
            <div><span>Peer IPs</span><strong>{state.trafficStats.peerAddresses.length}</strong><small>{state.trafficStats.rxPackets + state.trafficStats.txPackets > 0 ? 'Traffic frames recorded' : state.trafficStats.captureAvailable ? 'Capture ready; waiting for packets' : 'Waiting for packets'}</small></div>
            <div><span>Last activity</span><strong className="traffic-last">{state.trafficStats.lastActivityAt ? new Date(state.trafficStats.lastActivityAt).toLocaleTimeString() : '—'}</strong><small>{state.trafficStats.captureAvailable ? 'Capture active or complete' : 'No frames captured yet'}</small></div>
          </div>
          <div className="traffic-peers"><strong>Observed peers</strong><span>{state.trafficStats.peerAddresses.length ? state.trafficStats.peerAddresses.join(' · ') : 'No peer IP addresses observed yet. Run a scan or connect to a service from your attacker VM.'}</span></div>
        </> : <div className="traffic-empty">{selectedMachine ? 'Start this target to monitor packets entering and leaving its virtual NIC.' : 'Select an imported target to view its network activity.'}</div>}
        <p className="traffic-footnote">Lightweight telemetry (up to 54 bytes per frame; may include a short payload prefix). Full packets are not stored, and the temporary capture is deleted when the target stops.</p>
      </section>

      <section className="panel network-panel">
        <div className="panel-heading"><div><h2>Attacker connectivity</h2><p>Use NAT port forwards or a shared bridged Layer-2 network</p></div><span className="network-badge"><span className="dot amber"/>Attacker VM remains manual</span></div>
        <div className="network-flow"><div className="network-node"><div className="node-icon">⌘</div><div><strong>Attacker VM</strong><span>Kali, Parrot OS, or another compatible VM</span></div></div><div className="tunnel"><div className="tunnel-line"/><span>{networkMode === 'nat' ? 'NAT · forwarded service ports' : 'Bridged · Layer-2 Ethernet'}</span></div><div className="network-node"><div className="node-icon target">▣</div><div><strong>{selectedMachine?.name ?? 'QEMU target'}</strong><span>{selectedMachine?.ipAddress ?? (selectedMachine?.status === 'running' ? 'IP discovery pending' : 'Target stopped')}</span></div></div></div>
        <div className="network-actions"><button className="secondary-button" disabled={busy} onClick={() => void runAction(() => window.lab.openNetworkSetupFiles(), 'Opened the network setup files.')}>Network setup files</button><div className="network-hint">VulnLab Manager starts only its QEMU target. It never starts or reconfigures Kali/Parrot. NAT exposes only the ports you forward; macOS bridged mode requires socket_vmnet; Windows bridged mode requires the ARM64 TAP-Windows driver and a shared isolated network segment.</div></div>
      </section>

      <footer>VulnLab Manager · General-purpose local VM orchestration · Imported machine images are untrusted; inspect before booting.</footer>
    </main>
  </div>;
}
