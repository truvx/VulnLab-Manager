#!/usr/bin/env bash
set -Eeuo pipefail

# VulnLab Manager generic Linux guest network helper.
# Usage: sudo bash lab-network-setup.sh [interface]
# It configures only the selected isolated interface. Never run it against a
# normal internet-facing interface. Defaults: 192.168.77.1/24 and DHCP .10-.200.

PROFILE="VulnLab-Isolated"
GATEWAY_IP="192.168.77.1"
GATEWAY_CIDR="${GATEWAY_IP}/24"
DHCP_START="192.168.77.10"
DHCP_END="192.168.77.200"
CONFIG_DIR="/etc/vulnlab"
DNSMASQ_CONFIG="${CONFIG_DIR}/dnsmasq.conf"
SERVICE_FILE="/etc/systemd/system/vulnlab-dhcp.service"
LEASE_FILE="/var/lib/misc/vulnlab-dhcp.leases"

say() { printf '\n[VulnLab] %s\n' "$*"; }
die() { printf '\n[VulnLab] ERROR: %s\n' "$*" >&2; exit 1; }

if [[ "${EUID}" -ne 0 ]]; then
  die "Run as root: sudo bash lab-network-setup.sh [interface]"
fi
command -v ip >/dev/null 2>&1 || die "The iproute2 'ip' command is required."

IFACE="${1:-}"
if [[ -z "$IFACE" ]]; then
  mapfile -t IFACES < <(ip -o link show | awk -F': ' '{name=$2; sub(/@.*/,"",name); if (name != "lo") print name}')
  ((${#IFACES[@]} > 0)) || die "No network interfaces were detected."
  say "Choose the isolated lab adapter (usually VirtualBox Adapter 2):"
  for i in "${!IFACES[@]}"; do printf '  %d) %s\n' "$((i+1))" "${IFACES[$i]}"; done
  read -r -p 'Interface number: ' PICK
  [[ "$PICK" =~ ^[0-9]+$ ]] || die "Enter a valid interface number."
  (( PICK >= 1 && PICK <= ${#IFACES[@]} )) || die "Selection out of range."
  IFACE="${IFACES[$((PICK-1))]}"
fi
ip link show dev "$IFACE" >/dev/null 2>&1 || die "Interface '$IFACE' does not exist. Check the VM's second network adapter."
[[ "$IFACE" != "lo" ]] || die "Loopback cannot be used as a lab adapter."

DEFAULT_IFACE="$(ip -4 route show default 2>/dev/null | awk 'NR==1 {for(i=1;i<=NF;i++) if($i=="dev") {print $(i+1); exit}}')"
if [[ "$IFACE" == "$DEFAULT_IFACE" ]]; then
  die "'$IFACE' is the default-route interface. Refusing to modify your internet connection. Choose the isolated second adapter instead."
fi

if [[ ! "$GATEWAY_IP" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then
  die "Gateway must be an IPv4 address, such as 192.168.77.1."
fi
say "Selected interface: $IFACE"
say "Lab-side address: ${GATEWAY_CIDR}"
say "DHCP pool: ${DHCP_START} - ${DHCP_END}"
printf 'This changes only %s. Continue? [y/N] ' "$IFACE"
read -r CONFIRM
[[ "$CONFIRM" =~ ^[Yy]$ ]] || die "Cancelled. No network settings were changed."

if command -v nmcli >/dev/null 2>&1; then
  if nmcli -t -f NAME connection show | grep -Fxq "$PROFILE"; then
    nmcli connection modify "$PROFILE" connection.interface-name "$IFACE" connection.autoconnect yes \
      ipv4.method manual ipv4.addresses "$GATEWAY_CIDR" ipv4.never-default yes ipv6.method disabled
  else
    nmcli connection add type ethernet ifname "$IFACE" con-name "$PROFILE" connection.autoconnect yes \
      ipv4.method manual ipv4.addresses "$GATEWAY_CIDR" ipv4.never-default yes ipv6.method disabled
  fi
  nmcli connection up "$PROFILE"
else
  say "NetworkManager is not installed; applying a temporary address (it will not persist after reboot)."
  ip link set dev "$IFACE" up
  ip address replace "$GATEWAY_CIDR" dev "$IFACE"
fi

if ! command -v dnsmasq >/dev/null 2>&1; then
  say "dnsmasq is missing. Attempting installation with the available package manager."
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install -y dnsmasq
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y dnsmasq
  elif command -v pacman >/dev/null 2>&1; then
    pacman -Sy --noconfirm dnsmasq
  elif command -v zypper >/dev/null 2>&1; then
    zypper --non-interactive install dnsmasq
  else
    die "Install dnsmasq with your distribution's package manager, then rerun this script."
  fi
fi
DNSMASQ_BIN="$(command -v dnsmasq)"
install -d -m 0755 "$CONFIG_DIR" /var/lib/misc
cat > "$DNSMASQ_CONFIG" <<EOF
# Dedicated VulnLab DHCP instance. Bound only to the selected isolated adapter.
port=0
interface=${IFACE}
bind-dynamic
except-interface=lo
dhcp-authoritative
dhcp-range=${DHCP_START},${DHCP_END},255.255.255.0,12h
dhcp-leasefile=${LEASE_FILE}
log-dhcp
EOF
"$DNSMASQ_BIN" --test --conf-file="$DNSMASQ_CONFIG"

if command -v systemctl >/dev/null 2>&1 && [[ -d /run/systemd/system ]]; then
  cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=VulnLab isolated guest DHCP service
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${DNSMASQ_BIN} --no-daemon --conf-file=${DNSMASQ_CONFIG} --pid-file=/run/vulnlab-dhcp.pid
Restart=on-failure

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable --now vulnlab-dhcp.service
  systemctl --no-pager --full status vulnlab-dhcp.service | sed -n '1,9p'
else
  say "systemd was not detected. Starting a foreground-independent DHCP process for this session."
  pgrep -f "dnsmasq.*${DNSMASQ_CONFIG}" >/dev/null 2>&1 || nohup "$DNSMASQ_BIN" --conf-file="$DNSMASQ_CONFIG" --pid-file=/run/vulnlab-dhcp.pid >/var/log/vulnlab-dhcp.log 2>&1 &
fi

say "Lab interface configured."
ip -br address show dev "$IFACE"
say "This helper does not configure the target VM or any attacker VM software. Both guests must use the same isolated subnet."
