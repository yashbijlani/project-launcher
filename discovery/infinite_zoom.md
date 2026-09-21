# Discovery: infinite_zoom

- Path: `/home/penguin/code/infinite_zoom`
- Confidence: **0.50**
- Readiness: **needs_device**
- Unsafe to auto-run: **yes** (Android/Gradle project requires a device)
- Stack signals: Android

## Blockers

- [device] (android) service android requires a device or emulator
  - suggestion: Attach a device/emulator and run the documented build command manually

## Services

### android
- Command: `./gradlew build`
- Working directory: `.`
- Runtime: device
- Provenance: detector/android (confidence 0.75)
- Notes: Requires Android SDK, Gradle, and a device/emulator. Marked unsafe to auto-run.

## Detector evidence

- **AndroidDetector** (confidence 0.75)
  - Gradle project with settings.gradle(.kts)
  - Unity/Android-style project requiring a device or emulator

