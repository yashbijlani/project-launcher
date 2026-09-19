# Discovery: camera-copilot

- Path: `/home/penguin/code/camera-copilot`
- Confidence: **0.50**
- Unsafe to auto-run: **yes** (Android/Gradle project requires a device)
- Stack signals: Android

## Services

### android
- Command: `./gradlew build`
- Working directory: `.`
- Notes: Requires Android SDK, Gradle, and a device/emulator. Marked unsafe to auto-run.

## Detector evidence

- **AndroidDetector** (confidence 0.75)
  - Gradle project with settings.gradle(.kts)
  - Unity/Android-style project requiring a device or emulator

