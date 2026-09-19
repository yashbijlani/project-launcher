# Discovery: rune

- Path: `/home/penguin/code/rune`
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

## Startup verification

- Not built or installed.
- Classification: `DEVICE_REQUIRED`.
- Explicit README commands:
  - `./gradlew :app:assembleDebug`
  - `./gradlew test`
  - `./gradlew lint`
- Requirements: JDK 17, Android SDK, compile SDK 34, Gradle wrapper, plus an install target or emulator.
- No web port or HTTP health check applies.

