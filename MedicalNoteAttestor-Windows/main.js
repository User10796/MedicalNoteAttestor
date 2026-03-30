const { app, BrowserWindow, globalShortcut, clipboard, ipcMain, Menu, net, desktopCapturer, screen } = require('electron');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

// Portable config
const DEFAULTS = {
    hpiHotkey: 'PageUp',
    apHotkey: 'PageDown',
    heidiCopyEnabled: true,
    claudeApiKey: '',
    customClaudeInstructions: '',
    customAttestationTemplate: '',
    windowBounds: { width: 400, height: 500 }
};

function getConfigPath() {
    const portableDir = process.env.PORTABLE_EXECUTABLE_DIR;
    if (portableDir) {
        const portablePath = path.join(portableDir, 'MedicalNoteAttestor-config.json');
        if (fs.existsSync(portablePath)) {
            return portablePath;
        }
    }
    const configDir = path.join(process.env.APPDATA || path.join(require('os').homedir(), 'AppData', 'Roaming'), 'MedicalNoteAttestor');
    if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true });
    }
    return path.join(configDir, 'config.json');
}

function getSavePath() {
    const paths = [];
    const portableDir = process.env.PORTABLE_EXECUTABLE_DIR;
    if (portableDir) {
        paths.push(path.join(portableDir, 'MedicalNoteAttestor-config.json'));
    }
    const configDir = path.join(process.env.APPDATA || path.join(require('os').homedir(), 'AppData', 'Roaming'), 'MedicalNoteAttestor');
    if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true });
    }
    paths.push(path.join(configDir, 'config.json'));
    return paths;
}

function loadConfig() {
    try {
        const configPath = getConfigPath();
        if (fs.existsSync(configPath)) {
            const raw = fs.readFileSync(configPath, 'utf-8');
            return { ...DEFAULTS, ...JSON.parse(raw) };
        }
    } catch (e) {
        console.error('Failed to load config:', e);
    }
    return { ...DEFAULTS };
}

function saveConfig(data) {
    const json = JSON.stringify(data, null, 2);
    for (const p of getSavePath()) {
        try {
            fs.writeFileSync(p, json, 'utf-8');
        } catch (e) {
            console.error('Failed to save config to', p, e);
        }
    }
}

const configData = loadConfig();
const store = {
    get: (key) => configData[key] !== undefined ? configData[key] : DEFAULTS[key],
    set: (key, value) => { configData[key] = value; saveConfig(configData); }
};

let mainWindow;
let settingsWindow;
let overlayWindow;

// Heidi section headers
const HPI_HEADERS = [
    'Interval history, HPI:',
    'History of Present Illness (HPI):'
];
const AP_HEADERS = [
    'Assessment and plan:',
    'Assessment and Plan:',
    'Assessment & Plan:',
    'Assessment & plan:',
    'Assessment/Plan:',
    'A&P:',
    'A/P:',
    'ASSESSMENT AND PLAN:',
    'ASSESSMENT & PLAN:',
    'Assessment and Plan',
    'Assessment and plan',
    'Assessment & Plan'
];

function findAPStart(text) {
    for (const header of AP_HEADERS) {
        const idx = text.indexOf(header);
        if (idx !== -1) {
            return { index: idx, length: header.length };
        }
    }
    // Case-insensitive fallback
    const lower = text.toLowerCase();
    const patterns = ['assessment and plan', 'assessment & plan', 'assessment/plan'];
    for (const pat of patterns) {
        const idx = lower.indexOf(pat);
        if (idx !== -1) {
            // Find the end of this line header (look for colon or newline)
            let end = idx + pat.length;
            if (text[end] === ':') end++;
            return { index: idx, length: end - idx };
        }
    }
    return null;
}

function createMainWindow() {
    const bounds = store.get('windowBounds');

    mainWindow = new BrowserWindow({
        width: bounds.width,
        height: bounds.height,
        minWidth: 180,
        minHeight: 120,
        alwaysOnTop: true,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js')
        }
    });

    mainWindow.loadFile(path.join(__dirname, 'index.html'));

    mainWindow.on('resize', () => {
        const { width, height } = mainWindow.getBounds();
        store.set('windowBounds', { width, height });
    });

    mainWindow.on('closed', () => {
        mainWindow = null;
    });

    const menuTemplate = [
        {
            label: 'File',
            submenu: [{ role: 'quit' }]
        },
        {
            label: 'Edit',
            submenu: [
                { role: 'copy' },
                { role: 'paste' },
                { role: 'selectAll' }
            ]
        },
        {
            label: 'Settings',
            submenu: [{
                label: 'Preferences...',
                accelerator: 'CmdOrCtrl+,',
                click: () => openSettings()
            }]
        }
    ];

    const menu = Menu.buildFromTemplate(menuTemplate);
    Menu.setApplicationMenu(menu);
}

function openSettings() {
    if (settingsWindow) {
        settingsWindow.focus();
        return;
    }

    settingsWindow = new BrowserWindow({
        width: 550,
        height: 500,
        parent: mainWindow,
        modal: false,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js')
        }
    });

    settingsWindow.loadFile(path.join(__dirname, 'settings.html'));
    settingsWindow.setMenu(null);

    settingsWindow.on('closed', () => {
        settingsWindow = null;
        registerHotkeys();
    });
}

function registerHotkeys() {
    globalShortcut.unregisterAll();

    const enabled = store.get('heidiCopyEnabled');
    const hpiKey = store.get('hpiHotkey');
    const apKey = store.get('apHotkey');

    console.log('registerHotkeys called — enabled:', enabled, 'hpiKey:', hpiKey, 'apKey:', apKey);

    if (!enabled) {
        console.log('Heidi copy disabled, skipping hotkey registration');
        if (mainWindow) mainWindow.webContents.send('hotkey-status', { registered: false, reason: 'disabled' });
        return;
    }

    let hpiOk = false, apOk = false;

    try {
        hpiOk = globalShortcut.register(hpiKey, () => {
            console.log('HPI hotkey triggered!');
            extractAndCopySection('hpi');
        });
        console.log('HPI hotkey register result:', hpiOk);
    } catch (e) {
        console.error('Failed to register HPI hotkey:', e);
    }

    try {
        apOk = globalShortcut.register(apKey, () => {
            console.log('A&P hotkey triggered!');
            extractAndCopySection('ap');
        });
        console.log('A&P hotkey register result:', apOk);
    } catch (e) {
        console.error('Failed to register A&P hotkey:', e);
    }

    if (mainWindow) {
        mainWindow.webContents.send('hotkey-status', { registered: true, hpiOk, apOk, hpiKey, apKey });
    }
}

async function extractAndCopySection(section) {
    try {
        // Send Ctrl+A then Ctrl+C to the foreground window (e.g. Heidi)
        const psScript = "Add-Type -AssemblyName System.Windows.Forms; Start-Sleep -Milliseconds 50; [System.Windows.Forms.SendKeys]::SendWait('^a'); Start-Sleep -Milliseconds 100; [System.Windows.Forms.SendKeys]::SendWait('^c'); Start-Sleep -Milliseconds 100;";
        execSync(`powershell -NoProfile -Command "${psScript}"`, { timeout: 3000 });
    } catch (e) {
        console.error('Failed to auto-copy from foreground window:', e);
    }

    // Small delay to let clipboard populate
    await new Promise(r => setTimeout(r, 150));

    const text = clipboard.readText();
    if (!text) return;

    let extracted;
    if (section === 'hpi') {
        extracted = extractHPI(text);
    } else {
        extracted = extractAP(text);
    }

    if (extracted) {
        clipboard.writeText(extracted);
        if (mainWindow) {
            mainWindow.webContents.send('section-copied', section);
        }
    }
}

function extractHPI(text) {
    let hpiStart = -1;
    for (const header of HPI_HEADERS) {
        const idx = text.indexOf(header);
        if (idx !== -1) {
            hpiStart = idx + header.length;
            break;
        }
    }
    if (hpiStart === -1) {
        console.log('HPI header not found in text. First 200 chars:', text.substring(0, 200));
        return null;
    }
    const ap = findAPStart(text);
    if (!ap || ap.index <= hpiStart) {
        console.log('A&P header not found after HPI');
        return null;
    }
    return cleanUpText(text.substring(hpiStart, ap.index));
}

function extractAP(text) {
    const ap = findAPStart(text);
    if (!ap) {
        console.log('A&P header not found in text. First 500 chars:', text.substring(0, 500));
        return null;
    }
    console.log('Found A&P header at index', ap.index, ':', text.substring(ap.index, ap.index + 30));
    return cleanUpText(text.substring(ap.index + ap.length));
}

function cleanUpText(text) {
    let cleaned = text.replace(/\*\*/g, '').replace(/\*/g, '');
    cleaned = cleaned.trim();
    const lines = cleaned.split('\n');
    let startIdx = 0;
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].trim()) { startIdx = i; break; }
    }
    return lines.slice(startIdx).join('\n');
}

// ── Screen capture ──────────────────────────────────────────────────────────
// Captures the screen, shows a fullscreen overlay for region selection,
// returns the cropped NativeImage as a PNG data URL.

let screenshotImage = null; // NativeImage of full screen capture

ipcMain.handle('start-screen-capture', async () => {
    try {
        // Get display where main window lives
        const mainBounds = mainWindow.getBounds();
        const display = screen.getDisplayNearestPoint({ x: mainBounds.x, y: mainBounds.y });

        // Hide main window so it's not in the screenshot
        mainWindow.hide();
        await new Promise(r => setTimeout(r, 300));

        // Capture the screen
        const sources = await desktopCapturer.getSources({
            types: ['screen'],
            thumbnailSize: {
                width: display.size.width * display.scaleFactor,
                height: display.size.height * display.scaleFactor
            }
        });

        const source = sources.find(s => String(s.display_id) === String(display.id)) || sources[0];
        screenshotImage = source.thumbnail;

        // Create fullscreen overlay for selection
        overlayWindow = new BrowserWindow({
            x: display.bounds.x,
            y: display.bounds.y,
            width: display.size.width,
            height: display.size.height,
            frame: false,
            alwaysOnTop: true,
            fullscreen: true,
            skipTaskbar: true,
            webPreferences: {
                nodeIntegration: false,
                contextIsolation: true,
                preload: path.join(__dirname, 'overlay-preload.js')
            }
        });

        overlayWindow.loadFile(path.join(__dirname, 'overlay.html'));

        overlayWindow.webContents.on('did-finish-load', () => {
            const dataUrl = screenshotImage.toDataURL();
            overlayWindow.webContents.send('set-screenshot', dataUrl);
        });

        // Wait for selection or cancel
        return new Promise((resolve) => {
            const cleanup = () => {
                if (overlayWindow && !overlayWindow.isDestroyed()) {
                    overlayWindow.close();
                }
                overlayWindow = null;
                mainWindow.show();
                mainWindow.focus();
                mainWindow.setAlwaysOnTop(true);
            };

            ipcMain.once('selection-done', (event, rect) => {
                // rect = { x, y, width, height } in screen pixels
                if (rect && rect.width > 5 && rect.height > 5) {
                    const scaleFactor = display.scaleFactor;
                    const cropped = screenshotImage.crop({
                        x: Math.round(rect.x * scaleFactor),
                        y: Math.round(rect.y * scaleFactor),
                        width: Math.round(rect.width * scaleFactor),
                        height: Math.round(rect.height * scaleFactor)
                    });
                    cleanup();
                    resolve({ success: true, imageDataUrl: cropped.toDataURL() });
                } else {
                    cleanup();
                    resolve({ success: false, cancelled: true });
                }
            });

            ipcMain.once('selection-cancel', () => {
                cleanup();
                resolve({ success: false, cancelled: true });
            });

            overlayWindow.on('closed', () => {
                overlayWindow = null;
                // If closed without selection
                mainWindow.show();
                mainWindow.setAlwaysOnTop(true);
                resolve({ success: false, cancelled: true });
            });
        });
    } catch (err) {
        console.error('Screen capture error:', err);
        mainWindow.show();
        mainWindow.setAlwaysOnTop(true);
        return { success: false, error: err.message };
    }
});

// ── IPC handlers ────────────────────────────────────────────────────────────

ipcMain.handle('get-settings', () => {
    return {
        hpiHotkey: store.get('hpiHotkey'),
        apHotkey: store.get('apHotkey'),
        heidiCopyEnabled: store.get('heidiCopyEnabled'),
        claudeApiKey: store.get('claudeApiKey'),
        customClaudeInstructions: store.get('customClaudeInstructions'),
        customAttestationTemplate: store.get('customAttestationTemplate')
    };
});

ipcMain.handle('save-settings', (event, settings) => {
    store.set('hpiHotkey', settings.hpiHotkey);
    store.set('apHotkey', settings.apHotkey);
    store.set('heidiCopyEnabled', settings.heidiCopyEnabled);
    store.set('claudeApiKey', settings.claudeApiKey);
    store.set('customClaudeInstructions', settings.customClaudeInstructions);
    store.set('customAttestationTemplate', settings.customAttestationTemplate);
    registerHotkeys();
    return true;
});

ipcMain.handle('call-claude-api', async (event, text) => {
    const customInstructions = store.get('customClaudeInstructions');
    return await callClaudeAPI(text, customInstructions);
});

ipcMain.handle('copy-to-clipboard', (event, text) => {
    clipboard.writeText(text);
    return true;
});

ipcMain.handle('get-attestation-template', () => {
    const custom = store.get('customAttestationTemplate');
    if (custom && custom.trim()) {
        return custom;
    }
    return DEFAULT_ATTESTATION_TEMPLATE;
});

// ── Claude API ──────────────────────────────────────────────────────────────

const BUILT_IN_API_KEY = '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';

const BASE_SYSTEM_PROMPT = `You are a medical note reformatter. Transform the input according to these rules:

NAME REMOVAL:
- Delete all instances of "Dr. Haring"

MEDICATIONS:
- Continued/unchanged medications → combine into single bullet: "- Continue: [med1], [med2], [med3]"
- New medications → "- Start: [medication]"
- Stopped medications → "- Stop: [medication]"
- Changed medications → "- Change: [medication to new dosage/frequency]"
- Only include Start/Stop/Change bullets when actual changes exist

RECOMMENDATIONS:
- Preserve "Consider" language verbatim (don't convert to directives)

PROCEDURES:
- Each procedure gets its own bullet point
- Note if procedure was "performed today" vs "scheduled"

ABBREVIATIONS (expand all):
- BID → twice daily
- TID → three times daily
- QID → four times daily
- QD → once daily
- PRN → as needed
- PO → by mouth
- IM → intramuscular
- IV → intravenous
- ESI → epidural steroid injection
- TFESI → transforaminal epidural steroid injection
- ILESI → interlaminar epidural steroid injection
- CESI → caudal epidural steroid injection
- RFA → radiofrequency ablation
- MBB → medial branch block
- SI → sacroiliac
- SIJ → sacroiliac joint
- CRPS → complex regional pain syndrome
- PT → physical therapy
- OT → occupational therapy
- MRI → magnetic resonance imaging
- CT → computed tomography
- EMG → electromyography
- NCS → nerve conduction study
- NSAID → nonsteroidal anti-inflammatory drug
- HA → headache
- LBP → low back pain
- ROM → range of motion
- WNL → within normal limits
- F/U → follow up
- RTC → return to clinic

OUTPUT FORMAT:
- Use dash-space bullets ( - )
- No blank lines between bullets
- Single line per bullet (no wrapping)
- No nested sub-bullets
- Output ONLY the formatted bullets, no explanations
- At the END, on a new line, output one of these codes based on content:
  [CODE:NO_CHANGES] - if no medication changes and no procedures
  [CODE:MED_CHANGES] - if medication changes only (Start/Stop/Change present)
  [CODE:MED_AND_SCHEDULED] - if medication changes AND a scheduled procedure
  [CODE:PROCEDURE_TODAY] - if a procedure was performed today`;

const DEFAULT_ATTESTATION_TEMPLATE = `For this patient encounter, I personally saw this patient and formulated the plan together with the APP at the time of this visit. I agree with the [DYNAMIC_PLAN_TEXT]. I reviewed the APP's documentation, medical decision making and treatment plan, and agree with the documentation above. By my electronic signature I authenticate all APP orders and attest that all pages have been reviewed and completed.

Physical exam: Gen: No acute distress
HEENT: EOMI, NC/AT
CV: Extremities warm and perfused.
Pulm: No increased work of breathing.
Neuro: Moves extremities spontaneously. Alert and oriented.
Psych: Answered all questions appropriately.

Assessment: As above

Plan:

`;

async function callClaudeAPI(text, customInstructions) {
    const apiKey = store.get('claudeApiKey') || BUILT_IN_API_KEY;
    if (!apiKey || !apiKey.trim()) {
        return { success: false, error: 'No API key set. Go to Settings → Claude API to enter your key.' };
    }

    let systemPrompt = BASE_SYSTEM_PROMPT;
    if (customInstructions && customInstructions.trim()) {
        systemPrompt += '\n\nADDITIONAL INSTRUCTIONS:\n' + customInstructions;
    }

    try {
        const response = await net.fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify({
                model: 'claude-sonnet-4-20250514',
                max_tokens: 4096,
                system: systemPrompt,
                messages: [{ role: 'user', content: text }]
            })
        });

        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.error?.message || 'API error');
        }

        return { success: true, text: data.content[0].text };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

// ── App lifecycle ───────────────────────────────────────────────────────────

app.whenReady().then(() => {
    createMainWindow();
    registerHotkeys();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createMainWindow();
        }
    });
}).catch((err) => {
    console.error('Failed to start app:', err);
    app.quit();
});

app.on('window-all-closed', () => {
    globalShortcut.unregisterAll();
    app.quit();
});

app.on('will-quit', () => {
    globalShortcut.unregisterAll();
});
