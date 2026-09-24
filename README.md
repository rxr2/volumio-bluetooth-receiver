# volumio-bluetooth-receiver

**Free Bluetooth input for Volumio 4.** Your phone (or TV) streams to the Raspberry Pi over Bluetooth A2DP, and the audio plays through the **same DAC Volumio uses**. The Pi switches between Volumio and Bluetooth automatically, and the Bluetooth source shows up on Volumio's *Now Playing* screen, including the touch display.

[Polska wersja](README.pl.md)

```
phone / TV ──Bluetooth A2DP (aptX HD / aptX / SBC)──► Raspberry Pi ──► DAC (I2S HAT or USB)
                                                         ▲
                                   Volumio / MPD ────────┘  (automatic hand-over)
```

It is built from what's already in the Volumio 4 image: BlueZ, BlueALSA and `python3-dbus-fast`. It **installs nothing with apt**, adds no PulseAudio or PipeWire, and doesn't touch the I2S overlay, `mpd.conf`, `asound.conf` or the DAC settings.

This is an unofficial community project. It isn't affiliated with or endorsed by Volumio. If you want the supported, commercial solution, use Volumio Premium's Bluetooth input.

## Features

- **Automatic hand-over.** The switch happens only when the Bluetooth device actually **plays audio**. Just connecting or pairing does nothing, so a paired TV that's switched off never blocks Volumio.
  - Bluetooth starts playing: Volumio stops, the DAC is verified free (`/proc/asound/.../status`), then `bluealsa-aplay` starts.
  - The device disconnects (after 2 s) or goes silent for 20 s: `bluealsa-aplay` stops, the DAC is verified free, and Volumio can play again.
- **Now Playing integration** through a small Volumio plugin:
  - phone: title, artist, album, **cover art**, progress bar;
  - TV: device name;
  - both: **signal quality** (RSSI and link quality), **codec and bitrate**, sample rate and bit depth;
  - ⏮ ⏯ ⏭ on the screen **control the phone** (AVRCP).
- **End the session from the screen.** Pause or stop, picking any music in Volumio, or *Browse → Bluetooth audio → End session*. The device is disconnected and won't grab the DAC again for 60 s.
- **Best codec:** aptX HD (24-bit, 576 kbps), then aptX, then SBC. If the Pi initiated the connection (e.g. reconnect after boot), the service switches up to the best codec both sides support.
- **Bit-exact path to the DAC, no resampling.** The stream's sample rate is passed through. For I2S DACs the samples are only padded to S32_LE, the same format MPD uses in Volumio, so the bit clock doesn't change.
- **Safe pairing.** Only trusted devices may connect. New devices can pair only while a pairing window is open, started from the Volumio UI or `bt-audio pair`. Stock Volumio lets anyone in range pair.
- **Robust:**
  - event-driven over D-Bus, with no busy polling;
  - survives restarts of Volumio, BlueZ, BlueALSA and itself;
  - reconnects trusted devices after boot;
  - systemd units with `Restart=`, logging to journald.

## Requirements

- Volumio **4.x** (Debian 12 "bookworm"). Tested on Volumio 4.119 on a **Raspberry Pi 5** with the onboard Bluetooth.
- A working Volumio output DAC: an I2S HAT (e.g. "Generic I2S DAC" / hifiberry-dac overlay, tested with Ian Canada FifoPi Q7 + ES9038Q2M) or a USB DAC.
- SSH enabled: open `http://<volumio>/dev` → SSH → Enable. Log in as `volumio` / `volumio`.

## Install

```bash
git clone https://github.com/rxr2/volumio-bluetooth-receiver.git
cd volumio-bluetooth-receiver
bash install.sh
```

The installer detects Volumio's output card by itself. You can override it with `--card <alsa-card-id>`, and set the DAC sample format with `--format S32_LE|none`. It backs up every file it changes to `/data/INTERNAL/bluetooth-audio-backup`, installs the service and the plugin, and restarts the Bluetooth stack.

Then pair a device: go to **Browse → Bluetooth audio → Pair a new device (2 min)** and pick your Volumio's Bluetooth name (e.g. `volumio`) on the phone or TV.

## Usage

| | |
|---|---|
| Status | `bt-audio status` (services, mode, DAC, devices) · `bt-audio api` (JSON) |
| Logs | `bt-audio logs` · `bt-audio follow` · `journalctl -t bt-audio-switch -t bt-audio-aplay -t bluealsa` |
| Pairing | `bt-audio pair 120` · `bt-audio close` · `bt-audio forget <MAC>` |
| End session | `bt-audio disconnect` (DAC back to Volumio) · `bt-audio take` (undo) |
| Connect | `bt-audio connect <MAC>` |
| Restart | `bt-audio restart` |

Settings live in `/etc/default/bluetooth-audio`: buffer size, idle timeout, resume Volumio after Bluetooth, codec preference and so on. Run `sudo systemctl restart bluetooth-audio-switch` after changing them.

## Uninstall

```bash
bash uninstall.sh
```

This removes the services, the plugin and the configuration, and restores the original `/etc/bluetooth/main.conf`.

A Volumio update or factory reset may wipe `/etc` and `/usr/local`. If that happens, run `bash install.sh` again. Pairings survive in `/var/lib/bluetooth` unless the reset wipes them.

## How it works

| Component | Role |
|---|---|
| `bluealsa.service` (Volumio's) + drop-in | BlueALSA as **A2DP sink only**, codecs SBC + aptX + aptX HD |
| `bluetooth-audio-switch.service` | Python daemon (`dbus_fast`): BlueZ pairing agent, watches `MediaTransport1.State`, hands the DAC over, reads AVRCP metadata, RSSI and codec, serves a local API on `127.0.0.1:8090` (JSON + server-sent events) |
| `bluetooth-audio-aplay.service` | `bluealsa-aplay` → ALSA PCM `bt_dac`, started and stopped by the switch, never enabled on its own |
| `/etc/alsa/conf.d/60-bluetooth-audio-output.conf` | `bt_dac` = `plug` → `hw:CARD=<dac>,DEV=0` (card by **name**, not number) |
| Volumio plugin `tv_bluetooth` | puts Volumio into "volatile" mode (like the AirPlay plugin), pushes the Now Playing state and maps the UI buttons |

### Design notes: things learned the hard way

- **MPD is never stopped, only its playback.** `volumio stop` makes MPD close the ALSA device, which is all that's needed. Stopping `mpd.service` for longer than a few seconds breaks Volumio: its MPD client reconnects only on `ECONNRESET`/`EPIPE`, not on `ECONNREFUSED`. Until `volumio.service` restarts, the library hangs.
- **`ReverseServiceDiscovery = false`** in Volumio's `/etc/bluetooth/main.conf` stops BlueZ from reading the phone's SDP records. Without them the AVRCP version is `0x0000`, so there's no `MediaPlayer1` object: no titles, no cover art, and the remote-control buttons don't work. The installer sets it to `true`, the BlueZ default.
- **Don't guess the ALSA card number.** On a Pi 5, cards 0 and 1 are HDMI and the I2S DAC is card 2. Everything here uses the card **id**.
- **LDAC can't be received.** Only the LDAC *encoder* library (`libldacBT_enc`) exists, so BlueALSA can send LDAC but not decode it. aptX HD is the best receive codec (open-source `libfreeaptx`). AAC isn't compiled into Volumio's BlueALSA.
- **Codec choice depends on who connects.** When the phone connects, Android picks the best codec. When the Pi connects (e.g. after boot), BlueZ picks, often SBC. The switch then calls `org.bluealsa.PCM1.SelectCodec` to move to aptX HD.
- **Bit depth to the DAC.** FIFO reclockers such as the FifoPi work at the format MPD uses (S32_LE, 64 fs BCLK). Sending S16 would change BCLK to 32 fs, which is why I2S cards get `format S32_LE`. That's lossless padding.

## Troubleshooting

- **The TV doesn't list the Pi as a speaker.**
  - Check that the TV has Bluetooth *audio output* at all. Many budget models, e.g. Samsung NU7100, only use Bluetooth for the remote.
  - Check the range. The Pi 5 antenna is weak inside metal cases, and a USB Bluetooth adapter with an external antenna helps.
  - Some TVs filter by device class. You can test the loudspeaker class with `sudo hciconfig hci0 class 0x240414`; this isn't persistent.
- **No titles or cover art from the phone.** Check `grep ReverseServiceDiscovery /etc/bluetooth/main.conf`, then forget and re-pair the phone. YouTube sends the channel name as the artist, so the cover lookup usually fails. Spotify and YouTube Music send full metadata.
- **Crackles.** Increase `APLAY_BUFFER_US` (e.g. `300000`). With weak signal, a single underrun right after connecting is normal.
- **Latency.** The default ALSA buffer is 200 ms, plus about 15 ms for decoding, plus the sender's own buffering (roughly 50–150 ms). Expect about 0.3 s in total. That's fine for music. For video, use the TV's lip-sync setting if it has one for Bluetooth.

## Related

- [volumio-ytmusic-cookie-sync](https://github.com/rxr2/volumio-ytmusic-cookie-sync): Chrome extension that keeps the Volumio YouTube Music plugin signed in (VBR 256 kbps instead of 160).

## License

MIT, see [LICENSE](LICENSE).
