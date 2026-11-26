# QEMU target networking

VulnLab Manager configures networking independently for each imported machine. The application starts and stops **only its selected QEMU target**. It does not start, stop, or reconfigure Kali, Parrot, VirtualBox, or another attacker VM.

Choose **NAT** for the simplest cross-platform setup, or **Bridged (TAP)** when the host has a TAP adapter connected to the same isolated Layer-2 segment as the attacker VM.

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

## Bridged (TAP)

Bridged mode connects the QEMU E1000 NIC to a host TAP adapter using QEMU's tap backend. The target gets its address from the DHCP server on the Layer-2 network to which that TAP device is connected. This allows full network-level interaction (including ARP discovery and port scans) when the attacker VM is attached to the same segment.

This mode requires a TAP device/driver and host-side Layer-2 connectivity. VulnLab Manager deliberately does not install kernel drivers, elevate privileges, create host bridges, or change host network interfaces automatically.

### macOS Apple Silicon

- Install and configure a macOS TAP driver that provides a device such as /dev/tap0.
- Enter the device name (for example, tap0) in the machine's Bridged network settings.
- Connect that TAP interface to an isolated Layer-2 segment shared with the attacker VM before starting the target.
- If using VirtualBox, configure the attacker adapter to the same isolated network segment.

The QEMU vmnet backend is not assumed by this application: Apple's com.apple.vm.networking entitlement is restricted and must be requested from Apple. This build uses a user-provided TAP device for bridged networking instead.

### Windows 11 ARM64

- Install an ARM64-compatible TAP-Windows NDIS 6 driver. The OpenVPN tap-windows6 project includes ARM64 driver source/package support; the driver is not bundled with VulnLab Manager.
- Find the adapter's exact Windows interface name (for example, with PowerShell Get-NetAdapter) and enter that name in the machine's Bridged network settings.
- Connect the TAP adapter and your attacker VM to the same isolated Layer-2 segment using Windows networking/VirtualBox configuration.
- Start the QEMU target and let the segment's DHCP server assign an address.

Driver installation and creation of Windows Network Bridges require administrator approval and are intentionally left to the user.

### Security

Bridged mode places the vulnerable guest on the chosen Layer-2 network. Do not bridge intentionally vulnerable machines to a public Wi-Fi network, trusted home/work LAN, or any segment containing devices you do not intend to test. Use a dedicated isolated network or lab VLAN.

## IP address display

- NAT mode displays the QEMU DHCP address expected by the built-in user network (10.77.0.15) while the target is running.
- Bridged mode attempts to resolve the guest's configured virtual MAC address from the host ARP table. It may show **waiting for DHCP/ARP** until the guest has requested an address or exchanged traffic.
- The host IPv4 addresses displayed in the NAT settings are the addresses the attacker VM should use to reach forwarded host ports. They are not the guest's NAT IP.

## Network setup helper

The optional lab-network-setup.sh remains available for manually configuring a Linux attacker VM's selected isolated interface and DHCP service. Copy it into the attacker VM and run it yourself. It is not required for QEMU NAT, and it must not be run on the host's internet-facing interface. For NAT mode the QEMU user network supplies guest-side DHCP; do not run an additional DHCP server on that same guest network.

## Troubleshooting

- **NAT guest has no address:** confirm the guest is set to obtain IPv4 by DHCP and restart it.
- **Kali cannot reach a forwarded port:** use one of the host IPv4 addresses shown in the app; verify that the host OS firewall permits the host-side port; verify that the selected host port is forwarded to the service's actual guest port.
- **Port-forward collision:** choose a different host port in Machine configuration. Guest service ports do not need to change.
- **Bridged target has no IP:** verify the TAP driver/device is installed, the TAP adapter is connected to the same isolated Layer-2 network as the attacker, and DHCP is available on that segment.
- **Bridged mode fails at launch:** confirm the TAP adapter name exactly matches the host device name and that the current user has permission to open it.

QEMU network backend references: https://www.qemu.org/docs/master/system/devices/net.html and https://www.qemu.org/docs/master/system/qemu-manpage.html#network-options.
