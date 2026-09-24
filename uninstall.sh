#!/bin/bash
# volumio-bluetooth-receiver - full rollback to the Volumio state before install.sh
# Run as user "volumio":  bash uninstall.sh
set -u
BACKUP=/data/INTERNAL/bluetooth-audio-backup/configs

echo "== stopping and disabling services"
sudo systemctl disable --now bluetooth-audio-switch.service 2>/dev/null
sudo systemctl stop bluetooth-audio-aplay.service 2>/dev/null

echo "== removing units, BlueALSA override, programs and configuration"
sudo rm -f /etc/systemd/system/bluetooth-audio-switch.service /etc/systemd/system/bluetooth-audio-aplay.service
sudo rm -f /etc/systemd/system/bluealsa.service.d/10-a2dp-sink-only.conf
sudo rmdir /etc/systemd/system/bluealsa.service.d 2>/dev/null
sudo rm -f /usr/local/bin/volumio-bt-audio-switch /usr/local/bin/bt-audio
sudo rm -f /etc/default/bluetooth-audio /etc/alsa/conf.d/60-bluetooth-audio-output.conf
sudo rm -rf /run/bluetooth-audio
sudo systemctl daemon-reload

echo "== restoring /etc/bluetooth/main.conf"
if [ -r "$BACKUP/etc/bluetooth/main.conf" ]; then
  sudo tee /etc/bluetooth/main.conf < "$BACKUP/etc/bluetooth/main.conf" >/dev/null
else
  sed '/^# volumio-bluetooth-receiver:/d; s/^ReverseServiceDiscovery = true/ReverseServiceDiscovery = false/' \
    /etc/bluetooth/main.conf > /tmp/main.conf.new && sudo tee /etc/bluetooth/main.conf < /tmp/main.conf.new >/dev/null
fi

echo "== removing the Volumio plugin"
( cd /volumio && node -e '
  const io=require("socket.io-client"); const s=io("http://127.0.0.1:3000",{transports:["websocket"]});
  s.on("connect",()=>{ s.emit("pluginManager",{name:"tv_bluetooth",category:"music_service",action:"disable"});
    setTimeout(()=>s.emit("pluginManager",{name:"tv_bluetooth",category:"music_service",action:"uninstall"}),3000);
    setTimeout(()=>process.exit(0),9000); });
  setTimeout(()=>process.exit(0),15000);' ) 2>/dev/null
sudo rm -rf /data/plugins/music_service/tv_bluetooth

echo "== restarting the Bluetooth stack (BlueALSA back to Volumio defaults)"
sudo systemctl restart bluetooth bluealsa
echo
echo "Done. Paired devices are kept - remove them with: sudo bluetoothctl remove <MAC>"
echo "Backup and audit files stay in /data/INTERNAL/bluetooth-audio-backup"
