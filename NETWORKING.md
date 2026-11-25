# Generic isolated network setup

VulnLab Manager starts and stops **only the selected QEMU target**. It does not start, stop, configure, or require Kali, Parrot, VirtualBox, or another attacker VM. You choose and manage the attacker environment manually.

## Host-side QEMU endpoint

The target's E1000 NIC uses a localhost UDP datagram backend:

- QEMU local UDP endpoint: `127.0.0.1:10002`
- QEMU remote UDP endpoint: `127.0.0.1:10001`

## VirtualBox attacker VM adapter

Power off the attacker VM before changing adapter settings. Configure its second adapter:

1. Enable Adapter 2 and select **Generic Driver**.
2. Choose **UDP Tunnel**.
3. Destination address: `127.0.0.1`.
4. Source port: `10001`.
5. Destination port: `10002`.
6. Enable **Cable Connected**.

Do not change Adapter 1 if it provides internet access. Other hypervisors must provide an equivalent isolated UDP/Ethernet endpoint; this release does not configure them automatically.

## Guest IP configuration

The UDP tunnel carries Ethernet frames; it does not assign IP addresses. The attacker and target need addresses in the same isolated subnet. For this release, the included Linux helper defaults to `192.168.77.0/24` and configures the selected attacker-side interface as `192.168.77.1/24`. It offers DHCP addresses from `192.168.77.10` to `192.168.77.200`. The vulnerable target must be configured for DHCP or assigned a static address in that same subnet.

### Optional generic Linux helper

Copy `lab-network-setup.sh` manually from the project ZIP into the attacker VM (for example, `/root/lab-network-setup.sh` or the user home directory). Then run it from that location:

```bash
sudo bash /root/lab-network-setup.sh
```

The script lists detected interfaces and asks you to choose the isolated lab adapter. You can also copy it to your home directory and run `sudo bash ~/lab-network-setup.sh`. You can also specify it explicitly:

```bash
sudo bash lab-network-setup.sh enp0s8
```

It refuses to configure the system's default-route interface. It supports NetworkManager for a persistent address profile and uses dnsmasq for DHCP. It can install dnsmasq using apt, dnf, pacman, or zypper. On systems without NetworkManager, the IP address is applied for the current session only. The script requires a systemd service manager for persistent DHCP startup; otherwise it starts DHCP for the current session. Review the script before running it, and do not run it on a public or internet-facing interface.

The helper is optional. You can configure static IP addresses manually or use another DHCP server, provided it is bound only to the isolated lab network. Avoid running multiple DHCP servers on the same isolated segment.

## Normal workflow

1. Start your preferred attacker VM manually.
2. Configure its isolated adapter for the UDP tunnel above.
3. Run the generic network helper or configure guest networking manually.
4. Start the selected vulnerable target from VulnLab Manager.
5. Verify both guests are on the same subnet and can reach each other.
6. Stop the target from the app. The attacker VM remains under your control.

## Scope and limitations

The current QEMU launcher supports one x86/i386 target at a time and uses a BIOS/IDE/E1000 compatibility profile. Some images require UEFI, SCSI/SATA/NVMe, VirtIO, or other device profiles that are not yet auto-detected. Hosted platforms may not permit exporting VM images; only import files you are authorized to use.
