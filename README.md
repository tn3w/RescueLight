<div align="center">

<img src="https://github.com/tn3w/RescueLight/releases/download/img/preview.gif" width="670" alt="Max white, SOS, strobe and battery modes side by side">

<br>

<h1>
<picture>
<source media="(prefers-color-scheme: dark)" srcset="https://github.com/tn3w/RescueLight/releases/download/img/title-dark.png">
<img src="https://github.com/tn3w/RescueLight/releases/download/img/title-light.png" width="346" alt="Rescue Light">
</picture>
</h1>

**Turns a phone screen into an emergency signal light.**
Full brightness, edge to edge, 17 KB, no permissions.

<a href="https://github.com/tn3w/RescueLight/releases/download/v1.0/RescueLight-1.0.apk">
<img src="https://img.shields.io/badge/Download-APK%2017%20KB-C62828?style=for-the-badge&logo=android&logoColor=white" alt="Download RescueLight 1.0 APK">
</a>

</div>

<br>

**Tap** to change mode, **long-press** to enable a loud alarm tone. Both preferences are stored.

| Mode | Light | Why |
|------|-------|-----|
| **Max white** | steady white | the most photons a screen can emit, seen farthest at night |
| **SOS** | Morse `···———···` | reads as deliberate distress, not ambient light |
| **Strobe** | flash, ~1 Hz | the distress cadence; flicker catches the eye before it focuses |
| **Battery** | green, 9% duty | green is cheap on OLED and near the night-adapted eye's peak, ~3× runtime |

The tone is synthesized in code (no audio files) on the alarm stream, so it sounds
even on silent. Sound and light pulse together.

## Build

```
node apkbuild.js                        # → build/RescueLight-1.0.apk
adb install -r build/RescueLight-1.0.apk
```

`apkbuild.js` compiles the manifest, `src/` and `res/` into a signed APK with
the Android SDK tools. Requires JDK and SDK build-tools.

Release key at `~/.apkbuild/keys/<package>.jks`, with its password in a sibling `.pass` file.

## Disclaimer

Not a certified safety device, carry proper equipment. Signal distress only in
a genuine emergency; false alarms are a criminal offence. Flashing modes may
affect photosensitive people; the tone is loud. No warranty, use at your own
risk, see [LICENSE](LICENSE).
