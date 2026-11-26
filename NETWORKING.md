# QEMU target networking

VulnLab Manager configures networking independently for each imported machine and includes a live QEMU NIC monitor. The monitor records packet counts, byte counts, and peer IP addresses using a maximum 54-byte packet prefix (which can contain a short payload prefix); the temporary pcap is deleted when the target exits. The application starts and stops **only its selected QEMU target**. It does not start, stop, or reconfigure Kali, Parrot, VirtualBox, or another attacker VM.

Choose **NAT** for the simplest cross-platform setup, or **Bridged** when you need full Layer-2 access (ARP discovery and unrestricted port scans) between the target and attacker VM. macOS uses socket_vmnet; Windows ARM64 uses a TAP-Windows adapter.

## NAT (recommended for most hosts)

NAT uses QEMU's built-in user-mode network stack. It works without administrator privileges or a separate host network driver. The QEMU guest receives DHCP configuration on 10.77.0.0/24; the expected guest address is 10.77.0.15.

QEMU user-mode networking blocks unsolicited inbound traffic. VulnLab Manager therefore configures explicit host-forwarding rules for the selected machine. The defaults are:

| Protocol | Host port | Guest port | Service |
|---|---:|---:|---|
| TCP | 2222 | 22 | SSH |
| TCP | 8080 | 80 | HTTP |
| TCP | 8443 | 443 | HTTPS |
| TCP | 1445 | 445 | SMB |
| TCP | 13306 | 3306 | MySQL |

You can edit, add, or remove TCP/UDP rules under **Machine configuration → Network mode → NAT**. Host ports must be 1024–65535; guest ports may be 1–65535.

### Attacking a NAT-mode target from Kali or Parrot

1. Start the attacker VM manually.
2. Start the QEMU target from VulnLab Manager with NAT selected.
3. In the app, note one of the **Host IPv4 addresses** listed in the network settings.
4. From the attacker VM, scan the forwarded host ports, for example:

   ```bash
   nmap -sV -Pn -p 2222,8080,8443,1445,13306 <HOST-IP>
   ```

5. Connect to a forwarded service using the host address and host-side port. For example, browse to http://<HOST-IP>:8080 for the guest's port 80 service.

NAT is not a transparent Layer-2 network. The attacker VM cannot ARP-scan the guest's private 10.77.0.0/24 address or scan ports that have not been forwarded. Add a forwarding rule for each service you need to reach. A guest using a manually configured static IP rather than DHCP must be changed to use the QEMU NAT subnet/address expected by the rules, or use Bridged mode instead.

**Exposure warning:** forwarded ports bind to all host interfaces so the attacker VM can reach them. A host firewall may need to allow those host-side ports. Keep the target on a trusted, isolated environment, remove unused forwards, and do not expose deliberately vulnerable services to an untrusted LAN or the internet.

## Bridged

Bridged mode attaches the QEMU E1000 NIC to a host Layer-2 network. The vulnerable guest gets an address from DHCP on that network (or can use a static address in its subnet). When the attacker VM is attached to the same segment, it can ARP-discover the target and scan all guest services without per-port forwards.

This is the mode to use when you want the same network behavior as a conventional bridged VM. It requires platform-specific host networking setup; VulnLab Manager does not install kernel drivers, elevate privileges, create system bridges, or modify host networking automatically.

### macOS Apple Silicon — socket_vmnet

macOS uses the [socket_vmnet](https://github.com/lima-vm/socket_vmnet) helper. QEMU itself runs as your normal user; only the socket_vmnet daemon runs as root. The app detects `socket_vmnet_client` and the bridged socket for the selected host interface.

1. Install the helper:

   ```bash
   brew install socket_vmnet
   ```

2. Identify the host interface to bridge (usually `en0` for Wi-Fi or `enX` for another interface):

   ```bash
   networksetup -listallhardwareports
   ```

3. Create and start a bridged LaunchDaemon. For `en0`, run this in Terminal:

   ```bash
   PREFIX="$(brew --prefix)"
   SOCKET_PREFIX="$(brew --prefix socket_vmnet)"
   BRIDGED="en0"
   PLIST_SRC="$(find "$SOCKET_PREFIX" -name "io.github.lima-vm.socket_vmnet.bridged.en0.plist" -print -quit)"
   test -n "$PLIST_SRC" || { echo "socket_vmnet bridged LaunchDaemon template not found"; exit 1; }
   PLIST="/Library/LaunchDaemons/io.github.lima-vm.socket_vmnet.bridged.$BRIDGED.plist"
   sudo mkdir -p "$PREFIX/var/log/socket_vmnet"
   sudo chown root:wheel "$PREFIX/var/log/socket_vmnet"
   sed -e "s@/opt@$PREFIX/opt@g" -e "s@/var@$PREFIX/var@g" -e "s@en0@$BRIDGED@g" "$PLIST_SRC" | sudo tee "$PLIST" >/dev/null
   sudo chown root:wheel "$PLIST"
   sudo chmod 644 "$PLIST"
   sudo launchctl bootstrap system "$PLIST"
   sudo launchctl enable "system/io.github.lima-vm.socket_vmnet.bridged.$BRIDGED"
   sudo launchctl kickstart -kp "system/io.github.lima-vm.socket_vmnet.bridged.$BRIDGED"
   ```

   This installs a root-owned system LaunchDaemon for the chosen interface. It creates the socket at `$(brew --prefix)/var/run/socket_vmnet.bridged.en0`. Only do this for software and configuration you trust; socket_vmnet needs root to call Apple's vmnet framework. The daemon is separate from VulnLab Manager and is not started or stopped by the app.

4. In VulnLab Manager, select **Bridged**, choose the same interface name (for example `en0`), save, then start the target. The app launches QEMU through `socket_vmnet_client` and does not run QEMU as root.
5. In VirtualBox, power off Kali/Parrot and configure the attacker VM's second adapter as **Bridged Adapter**, selecting the same physical interface (for example `en0`). Keep the first adapter as your regular internet connection if needed.
6. If the Linux attacker VM still has the old static UDP-tunnel profile (for example `VulnLab-Lab` with `192.168.77.1/24`), change that second adapter to DHCP so it joins the bridged LAN:

   ```bash
   sudo nmcli connection modify "VulnLab-Lab" ipv4.method auto ipv4.addresses "" ipv4.gateway "" ipv4.never-default yes
   sudo nmcli connection up "VulnLab-Lab"
   ip -br addr show eth1
   ```

   Use your actual connection/profile and interface names if they differ. Keep `ipv4.never-default yes` so the lab interface does not replace the attacker's normal default internet route.
7. Start the attacker VM and QEMU target. Confirm they received addresses in the same subnet, then scan the segment from Kali/Parrot:

   ```bash
   sudo arp-scan --interface=eth1 --localnet
   sudo nmap -sn <LAB-SUBNET>
   ```

   The target's IP should appear in the QEMU machine list once the host ARP table has learned its MAC address.

**Important:** Bridging onto Wi-Fi may be restricted by some access points, enterprise networks, or VirtualBox/macOS driver behavior. A wired Ethernet interface and a dedicated isolated switch/VLAN are more reliable. Never bridge an intentionally vulnerable target to a public or trusted home/work LAN.

To remove the LaunchDaemon later:

```bash
BRIDGED="en0"
sudo launchctl bootout system "/Library/LaunchDaemons/io.github.lima-vm.socket_vmnet.bridged.$BRIDGED.plist"
sudo rm "/Library/LaunchDaemons/io.github.lima-vm.socket_vmnet.bridged.$BRIDGED.plist"
```

### Windows 11 ARM64 — TAP-Windows

QEMU's Windows TAP backend needs a separate TAP network driver; it is not included in the VulnLab Manager installer.

1. Install a signed ARM64-compatible NDIS 6.30 TAP-Windows driver. The upstream [OpenVPN tap-windows6 project](https://github.com/OpenVPN/tap-windows6) documents the ARM64 driver build/installation requirements. NDIS 6.20 is not sufficient on ARM64 desktop systems; use an NDIS 6.30 driver.
2. In an Administrator PowerShell, inspect adapters with `Get-NetAdapter`.
3. In VulnLab Manager select **Bridged** and enter the exact TAP adapter interface name shown by Windows.
4. Open Network Connections (`ncpa.cpl`) as an administrator. Select the TAP adapter and the intended lab-facing Ethernet adapter, then use **Bridge Connections** so QEMU's TAP interface is connected to the isolated lab segment. Do not bridge the TAP interface to an internet-facing or trusted network.
5. In VirtualBox, set the attacker's second adapter to **Bridged Adapter** on the same lab-facing network (or the resulting Network Bridge, as appropriate for your Windows setup). Keep its normal internet adapter separate. This host-side bridge setup requires administrator approval and is intentionally not performed by VulnLab Manager.
6. Start the target and confirm that a DHCP server on the shared segment assigns an IP address.

If Windows does not expose a compatible TAP adapter, use NAT mode. Do not install unsigned test drivers or disable Secure Boot just to make a lab network work.

### Security

Bridged mode places the vulnerable guest on the chosen Layer-2 network. Do not bridge intentionally vulnerable machines to a public Wi-Fi network, trusted home/work LAN, or any segment containing devices you do not intend to test. Use a dedicated isolated network or lab VLAN.

## IP address display

- NAT mode displays the QEMU DHCP address expected by the built-in user network (10.77.0.15) while the target is running.
- Bridged mode attempts to resolve the guest's configured virtual MAC address from the host ARP table. It may show **waiting for DHCP/ARP** until the guest has requested an address or exchanged traffic.
- The host IPv4 addresses displayed in NAT settings are the addresses the attacker VM should use to reach forwarded host ports. They are not the guest's NAT IP.

## Network setup helper

The optional lab-network-setup.sh remains available for manually configuring a Linux attacker VM's selected isolated interface and DHCP service. Copy it into the attacker VM and run it yourself. It is not required for QEMU NAT, and it must not be run on the host's internet-facing interface. For NAT mode the QEMU user network supplies guest-side DHCP; do not run an additional DHCP server on that same guest network.

## Troubleshooting

- **NAT guest has no address:** confirm the guest is set to obtain IPv4 by DHCP and restart it.
- **Kali cannot reach a forwarded port:** use one of the host IPv4 addresses shown in the app; verify that the host OS firewall permits the host-side port; verify that the selected host port is forwarded to the service's actual guest port.
- **Port-forward collision:** choose a different host port in Machine configuration. Guest service ports do not need to change.
- **Bridged target has no IP:** on macOS, verify the socket_vmnet LaunchDaemon is running for the selected enX interface and its bridged socket exists; on Windows, verify the ARM64 TAP-Windows adapter is installed. In both cases verify the attacker VM shares the same Layer-2 segment and DHCP is available.
- **Bridged mode fails at launch:** on macOS, confirm socket_vmnet_client is installed and the bridged LaunchDaemon socket path exists for the selected enX interface; on Windows, confirm the selected TAP adapter name matches the installed adapter.

QEMU network backend references: https://www.qemu.org/docs/master/system/devices/net.html and https://www.qemu.org/docs/master/system/qemu-manpage.html#network-options.
