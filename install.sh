#!/bin/bash
# volumio-bluetooth-receiver - installer
# Turns a Volumio 4 (Debian 12 "bookworm") Raspberry Pi into a Bluetooth A2DP receiver
# that shares the DAC with Volumio/MPD. Run as user "volumio" from the repository folder:
#
#   bash install.sh                      # auto-detect everything
#   bash install.sh --card sndrpihifiberry --format S32_LE
#
#   --card NAME     ALSA card id of the DAC (default: Volumio's configured output card)
#   --format FMT    force the sample format sent to the DAC, e.g. S32_LE, or "none"
#                   (default: S32_LE for I2S cards - same as MPD in Volumio -, none for USB DACs)
#
# Nothing is installed with apt: everything needed is part of the Volumio 4 image.
set -euo pipefail

REPO="$(cd "$(dirname "$0")" && pwd)"
BACKUP=/data/INTERNAL/bluetooth-audio-backup
CARD=""
FORMAT="auto"

while [ $# -gt 0 ]; do
  case "$1" in
    --card) CARD="$2"; shift 2 ;;
    --format) FORMAT="$2"; shift 2 ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *) echo "unknown option: $1"; exit 1 ;;
  esac
done

say() { printf '\n== %s\n' "$*"; }
die() { echo "ERROR: $*" >&2; exit 1; }

# ---------------------------------------------------------------- checks ----
say "checking the system"
[ -d /volumio ] || die "this does not look like Volumio (/volumio missing)"
[ "$(id -un)" = volumio ] || die "run as user 'volumio' (not root)"
for b in bluealsa bluealsa-aplay bluealsa-cli bluetoothctl python3 node; do
  command -v "$b" >/dev/null || die "$b not found - Volumio 4 (bookworm) image expected"
done
python3 -c "import dbus_fast" 2>/dev/null || die "python3-dbus-fast missing - Volumio 4 image expected"
[ -e /sys/class/bluetooth/hci0 ] || die "no Bluetooth adapter (hci0)"
grep -q '^ReverseServiceDiscovery' /etc/bluetooth/main.conf || echo "note: ReverseServiceDiscovery not set in main.conf (BlueZ default = true)"

if [ -z "$CARD" ]; then
  CARD=$(python3 -c "import json;print(json.load(open('/data/configuration/audio_interface/alsa_controller/config.json'))['outputdevicecardname']['value'])" 2>/dev/null || true)
fi
[ -n "$CARD" ] && [ -e "/proc/asound/$CARD" ] || die "cannot determine the DAC card - pass --card NAME (see /proc/asound/cards)"
if [ "$FORMAT" = auto ]; then
  if [ -e "/proc/asound/$CARD/stream0" ]; then FORMAT=none; else FORMAT=S32_LE; fi
fi
echo "DAC card: $CARD ($(cat /proc/asound/$CARD/id 2>/dev/null)), format to DAC: $FORMAT"

# ---------------------------------------------------------------- backup ----
say "backup of the files that will be changed -> $BACKUP"
mkdir -p "$BACKUP/configs"
for f in /etc/bluetooth/main.conf /lib/systemd/system/bluealsa.service /etc/asound.conf /etc/mpd.conf; do
  if [ -r "$f" ] && [ ! -e "$BACKUP/configs$f" ]; then
    mkdir -p "$BACKUP/configs$(dirname "$f")"; cp -p "$f" "$BACKUP/configs$f"; echo "saved $f"
  fi
done
[ -e "$BACKUP/dpkg-l.txt" ] || dpkg -l > "$BACKUP/dpkg-l.txt"
[ -e "$BACKUP/aplay-l.txt" ] || aplay -l > "$BACKUP/aplay-l.txt" 2>&1 || true

# ----------------------------------------------------------------- files ----
say "installing files"
sudo tee /usr/local/bin/volumio-bt-audio-switch < "$REPO/bin/volumio-bt-audio-switch" >/dev/null
sudo tee /usr/local/bin/bt-audio < "$REPO/bin/bt-audio" >/dev/null
sudo chmod 755 /usr/local/bin/volumio-bt-audio-switch /usr/local/bin/bt-audio

if [ -e /etc/default/bluetooth-audio ]; then
  echo "keeping existing /etc/default/bluetooth-audio"
else
  sed "s/@ALSA_CARD@/$CARD/" "$REPO/config/bluetooth-audio.default" | sudo tee /etc/default/bluetooth-audio >/dev/null
fi

if [ "$FORMAT" = none ]; then FMT_LINE=""; else FMT_LINE="        format $FORMAT"; fi
sudo tee /etc/alsa/conf.d/60-bluetooth-audio-output.conf >/dev/null <<EOF
# Installed by volumio-bluetooth-receiver: Bluetooth audio -> Volumio's DAC (card "$CARD").
# plug only converts what the card cannot take directly; the sample rate is passed through.
pcm.bt_dac {
    type plug
    slave {
        pcm "hw:CARD=$CARD,DEV=0"
$FMT_LINE
    }
}
EOF

sudo mkdir -p /etc/systemd/system/bluealsa.service.d
sudo tee /etc/systemd/system/bluealsa.service.d/10-a2dp-sink-only.conf < "$REPO/systemd/bluealsa-override.conf" >/dev/null
sudo tee /etc/systemd/system/bluetooth-audio-aplay.service < "$REPO/systemd/bluetooth-audio-aplay.service" >/dev/null
sudo tee /etc/systemd/system/bluetooth-audio-switch.service < "$REPO/systemd/bluetooth-audio-switch.service" >/dev/null

# BlueZ: Volumio disables reverse SDP; without it BlueZ does not learn the phone's AVRCP
# version -> no track titles / cover art / remote control buttons.
if grep -q '^ReverseServiceDiscovery = false' /etc/bluetooth/main.conf; then
  echo "enabling ReverseServiceDiscovery in /etc/bluetooth/main.conf"
  sed 's/^ReverseServiceDiscovery = false/# volumio-bluetooth-receiver: was false (Volumio default); true is needed for AVRCP metadata \/ remote control\nReverseServiceDiscovery = true/' \
    /etc/bluetooth/main.conf > /tmp/main.conf.new
  sudo tee /etc/bluetooth/main.conf < /tmp/main.conf.new >/dev/null
  rm -f /tmp/main.conf.new
fi

# -------------------------------------------------------------- services ----
say "starting services"
sudo systemctl daemon-reload
sudo systemctl restart bluetooth
sudo systemctl restart bluealsa
sudo systemctl enable bluetooth-audio-switch.service
sudo systemctl restart bluetooth-audio-switch.service

# ---------------------------------------------------------------- plugin ----
say "Volumio plugin (Now Playing display + end-session button)"
PLUGIN_DIR=/data/plugins/music_service/tv_bluetooth
if [ -d "$PLUGIN_DIR" ]; then
  echo "plugin already installed - updating its files and restarting Volumio"
  cp "$REPO"/plugin/tv_bluetooth/* "$PLUGIN_DIR"/
  sudo systemctl restart volumio
else
  rm -rf /tmp/tv_bluetooth && cp -r "$REPO/plugin/tv_bluetooth" /tmp/tv_bluetooth
  chmod +x /tmp/tv_bluetooth/*.sh
  ( cd /tmp/tv_bluetooth && echo y | volumio plugin install ) | tail -3 || true
  rm -rf /tmp/tv_bluetooth
  [ -d "$PLUGIN_DIR" ] || die "plugin installation failed (see: journalctl -u volumio)"
  ( cd /volumio && node -e '
    const io=require("socket.io-client"); const s=io("http://127.0.0.1:3000",{transports:["websocket"]});
    s.on("connect",()=>{ s.emit("pluginManager",{name:"tv_bluetooth",category:"music_service",action:"enable"});
      setTimeout(()=>process.exit(0),4000); });
    setTimeout(()=>process.exit(0),15000);' )
fi

say "done"
systemctl is-active bluetooth bluealsa bluetooth-audio-switch | paste -sd' '
cat <<'EOF'

Next steps:
  * pair a device: Volumio -> Browse -> "Bluetooth audio" -> "Pair a new device (2 min)"
    (or: bt-audio pair 120), then choose this Volumio in the phone's / TV's Bluetooth list
  * status: bt-audio status      logs: bt-audio logs      rollback: bash uninstall.sh
  * if the plugin does not show up yet: sudo systemctl restart volumio
EOF
