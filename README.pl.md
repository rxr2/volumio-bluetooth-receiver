# volumio-bluetooth-receiver (PL)

**Darmowe wejście Bluetooth dla Volumio 4.** Telefon (albo telewizor) gra do Raspberry Pi przez Bluetooth A2DP, a dźwięk idzie przez **ten sam DAC, którego używa Volumio**. Pi samo przełącza się między Volumio a Bluetooth, a źródło Bluetooth widać na ekranie *Now Playing* Volumio, także na ekranie dotykowym.

[English version](README.md)

```
telefon / TV ──Bluetooth A2DP (aptX HD / aptX / SBC)──► Raspberry Pi ──► DAC (I2S HAT lub USB)
                                                           ▲
                                     Volumio / MPD ────────┘  (automatyczne przełączanie)
```

Całość korzysta z tego, co już jest w obrazie Volumio 4: BlueZ, BlueALSA i `python3-dbus-fast`. **Niczego nie instaluje przez apt**, nie dodaje PulseAudio ani PipeWire i nie rusza overlayu I2S, `mpd.conf`, `asound.conf` ani ustawień DAC.

To nieoficjalny projekt społecznościowy, niezwiązany z Volumio. Oficjalne, płatne rozwiązanie to Bluetooth w Volumio Premium.

## Co potrafi

- **Automatyczne przełączanie.** Następuje dopiero wtedy, gdy urządzenie Bluetooth **faktycznie gra**. Samo połączenie czy sparowanie niczego nie przełącza, więc sparowany, wyłączony telewizor nie blokuje Volumio.
  - Bluetooth zaczyna grać: Volumio się zatrzymuje, zwolnienie DAC-a jest sprawdzane, potem startuje `bluealsa-aplay`.
  - Urządzenie się rozłącza (po 2 s) albo milknie na 20 s: DAC wraca do Volumio.
- **Ekran Now Playing:**
  - telefon: tytuł, wykonawca, album, **okładka**, pasek postępu;
  - TV: nazwa urządzenia;
  - dla obu: **jakość sygnału**, **kodek i bitrate**, częstotliwość i liczba bitów;
  - ⏮ ⏯ ⏭ na ekranie **sterują telefonem**.
- **Koniec sesji z ekranu.** Pauza lub stop, wybranie dowolnej muzyki w Volumio albo *Przeglądaj → Bluetooth audio → Zakończ sesję*.
- **Najlepszy kodek:** aptX HD (24 bit, 576 kbps), potem aptX, potem SBC. LDAC nie da się odbierać, bo istnieje tylko biblioteka kodująca.
- **Bez resamplingu.** Częstotliwość przechodzi bez zmian. Dla DAC-ów I2S próbki są tylko dopełniane do S32_LE, tak jak robi MPD.
- **Bezpieczne parowanie.** Łączyć się mogą tylko zaufane urządzenia. Nowe można sparować tylko w otwartym oknie parowania.

## Instalacja

Najpierw włącz SSH: `http://<volumio>/dev` → SSH → Enable (login `volumio` / `volumio`). Potem:

```bash
git clone https://github.com/rxr2/volumio-bluetooth-receiver.git
cd volumio-bluetooth-receiver
bash install.sh
```

Parowanie: **Przeglądaj → Bluetooth audio → Sparuj nowe urządzenie (2 min)**, a potem na telefonie lub TV wybierz nazwę Bluetooth swojego Volumio.

Obsługa: `bt-audio status | logs | pair 120 | disconnect | connect <MAC> | forget <MAC> | restart`. Ustawienia są w `/etc/default/bluetooth-audio`.

Deinstalacja: `bash uninstall.sh` usuwa wszystko i przywraca oryginalny `/etc/bluetooth/main.conf`. Po aktualizacji Volumio wystarczy ponownie uruchomić `bash install.sh`.

Szczegóły techniczne, uwagi projektowe i rozwiązywanie problemów są w [README.md](README.md).
