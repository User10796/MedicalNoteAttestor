# Medical Note Attestor - Windows

A Windows application for automating medical note attestation with Heidi AI scribe integration.

## Features

- **Heidi Copy**: Global hotkeys (PgUp/PgDn) to extract HPI and A&P sections from Heidi
- **Attestation**: Process medical notes through Claude API for formatting
- **Configurable**: Customize hotkeys, Claude instructions, and attestation template

## Building the Standalone .exe

### Prerequisites

1. **Node.js** (v18 or later): https://nodejs.org/
2. **Git** (optional): https://git-scm.com/

### Steps

1. Open Command Prompt or PowerShell in this folder

2. Install dependencies:
   ```
   npm install
   ```

3. Build the portable .exe:
   ```
   npm run build
   ```

4. Find the executable at:
   ```
   dist/MedicalNoteAttestor.exe
   ```

The resulting .exe is fully portable - no installation required. Just copy it anywhere and run.

### Development Mode

To run without building:
```
npm start
```

## Usage

### Heidi Copy Feature

1. Open Heidi and your note
2. Select all text in Heidi (Ctrl+A) and copy (Ctrl+C)
3. Press **Page Up** → HPI section is now on your clipboard
4. Go to Cerner Powerchart and paste (Ctrl+V) into the HPI field
5. Press **Page Down** → A&P section is now on your clipboard
6. Paste into the A&P field

### Attestation Feature

1. Copy text from Heidi
2. Click "Paste & Process" in the app
3. The text will be formatted via Claude API
4. Click "Copy" to copy the result

### Settings

Go to Settings → Preferences to:
- Change hotkeys (if PgUp/PgDn don't work on your keyboard)
- Add custom Claude API instructions
- Customize the attestation template

## Notes

- The app runs in the system tray when minimized
- Hotkeys work globally (even when the app is not focused)
- The Claude API key is embedded in the app

## Troubleshooting

**Hotkeys not working?**
- Make sure "Enable Heidi Copy Hotkeys" is checked in Settings
- Try different hotkey combinations (some keys may be reserved by your system)

**Clipboard not updating?**
- Make sure you Ctrl+A, Ctrl+C in Heidi first
- The hotkeys read from clipboard and extract sections
