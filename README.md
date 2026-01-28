# Medical Note Attestor

A macOS/Windows application for automating medical note attestation with Heidi AI scribe integration for Cerner Powerchart.

## Features

- **Heidi Copy**: Global hotkeys (PgUp/PgDn) to extract HPI and A&P sections from Heidi
- **Attestation**: Process medical notes through Claude API for intelligent formatting
- **Configurable**: Customize hotkeys, Claude instructions, and attestation template
- **Always on Top**: Floating window for easy access while working

## Platforms

- **macOS**: Native Swift/SwiftUI app
- **Windows**: Electron-based portable .exe

---

## macOS Version

### Building from Source

#### Prerequisites

1. **Xcode 15+**: Download from Mac App Store
2. **macOS 13+**: Required for SwiftUI features

#### Build Steps

1. Open `MedicalNoteAttestor.xcodeproj` in Xcode

2. Select your signing team:
   - Click the project in the navigator
   - Go to "Signing & Capabilities"
   - Select your team (or "Sign to Run Locally" for personal use)

3. Build and run:
   - Press `Cmd+R` to build and run
   - Or `Cmd+B` to just build

4. Find the app at:
   - Product → Show Build Folder in Finder
   - Or typically at: `~/Library/Developer/Xcode/DerivedData/MedicalNoteAttestor-xxx/Build/Products/Debug/MedicalNoteAttestor.app`

### Creating a DMG Installer

#### Option 1: Using create-dmg (Recommended)

1. Install create-dmg:
   ```bash
   brew install create-dmg
   ```

2. Build the release version in Xcode:
   - Product → Archive
   - Distribute App → Copy App

3. Create the DMG:
   ```bash
   create-dmg \
     --volname "Medical Note Attestor" \
     --window-pos 200 120 \
     --window-size 600 400 \
     --icon-size 100 \
     --icon "MedicalNoteAttestor.app" 150 185 \
     --app-drop-link 450 185 \
     "MedicalNoteAttestor.dmg" \
     "path/to/MedicalNoteAttestor.app"
   ```

#### Option 2: Manual DMG Creation

1. Build the app in Xcode (Product → Archive → Distribute App → Copy App)

2. Open Disk Utility

3. File → New Image → Blank Image:
   - Name: MedicalNoteAttestor
   - Size: 200 MB
   - Format: Mac OS Extended (Journaled)
   - Partitions: Single partition - GUID
   - Image Format: read/write

4. Mount the image and:
   - Drag the .app into it
   - Create an alias to /Applications and drag it in
   - Arrange icons nicely

5. Convert to read-only:
   - Disk Utility → Images → Convert
   - Select read-only compressed

### Accessibility Permissions

The app requires Accessibility permissions for global hotkeys:

1. Go to System Settings → Privacy & Security → Accessibility
2. Click the + button
3. Add MedicalNoteAttestor.app
4. Enable the toggle

---

## Windows Version

See `MedicalNoteAttestor-Windows/README.md` for build instructions.

Quick summary:
```bash
cd MedicalNoteAttestor-Windows
npm install
npm run build
```

The portable .exe will be in the `dist/` folder.

---

## Usage

### Heidi Copy Feature

1. **Setup**: Ensure hotkeys are enabled in Settings
2. **In Heidi**: Select all (Ctrl+A / Cmd+A) and copy (Ctrl+C / Cmd+C)
3. **Press Page Up**: HPI section → clipboard
4. **In Cerner**: Paste into HPI field
5. **Press Page Down**: A&P section → clipboard
6. **In Cerner**: Paste into A&P field

### Attestation Feature

1. Copy text from Heidi
2. Click "Select" (or paste if on Windows)
3. Wait for Claude API processing
4. Result is formatted with proper attestation template
5. Click "Copy" or enable "Auto-copy"

### Settings

Access via menu: **Settings → Preferences** (or Cmd+, on Mac)

- **Heidi Copy Tab**: Configure hotkeys
- **Claude API Tab**: Add custom formatting instructions
- **Attestation Tab**: Customize the attestation template

---

## Project Structure

```
MedicalNoteAttestor/
├── MedicalNoteAttestor/           # macOS Swift source
│   ├── MedicalNoteAttestorApp.swift
│   ├── ContentView.swift
│   ├── AttestorViewModel.swift
│   ├── ClaudeAPIClient.swift
│   ├── HeidiCopyService.swift     # NEW: Heidi copy logic
│   ├── SettingsManager.swift      # NEW: Settings persistence
│   ├── SettingsView.swift         # NEW: Settings UI
│   ├── TextFormatter.swift
│   ├── OCRService.swift
│   └── ScreenCaptureManager.swift
├── MedicalNoteAttestor-Windows/   # Windows Electron source
│   ├── main.js
│   ├── preload.js
│   ├── index.html
│   ├── renderer.js
│   ├── settings.html
│   └── package.json
└── README.md
```

---

## Notes

- Claude API key is embedded in both versions
- Asterisks are stripped from Heidi text (not converted to caps)
- The EMR target is Cerner Powerchart
- macOS version uses Carbon for global hotkeys
- Windows version uses Electron's globalShortcut
