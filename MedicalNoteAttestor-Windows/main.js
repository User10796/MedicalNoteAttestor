const { app, BrowserWindow, globalShortcut, clipboard, ipcMain, Menu } = require('electron');
const path = require('path');
const Store = require('electron-store');

// Initialize settings store
const store = new Store({
    defaults: {
        hpiHotkey: 'PageUp',
        apHotkey: 'PageDown',
        heidiCopyEnabled: true,
        customClaudeInstructions: '',
        customAttestationTemplate: '',
        windowBounds: { width: 400, height: 500 }
    }
});

let mainWindow;
let settingsWindow;

// Heidi section headers
const HPI_HEADERS = [
    'Interval history, HPI:',
    'History of Present Illness (HPI):'
];
const AP_HEADER = 'Assessment and Plan:';

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
        },
        icon: path.join(__dirname, 'icon.ico')
    });

    mainWindow.loadFile('index.html');

    // Save window size on resize
    mainWindow.on('resize', () => {
        const { width, height } = mainWindow.getBounds();
        store.set('windowBounds', { width, height });
    });

    mainWindow.on('closed', () => {
        mainWindow = null;
    });

    // Create menu
    const menuTemplate = [
        {
            label: 'File',
            submenu: [
                { role: 'quit' }
            ]
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
            submenu: [
                {
                    label: 'Preferences...',
                    accelerator: 'CmdOrCtrl+,',
                    click: () => openSettings()
                }
            ]
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

    settingsWindow.loadFile('settings.html');
    settingsWindow.setMenu(null);

    settingsWindow.on('closed', () => {
        settingsWindow = null;
        // Re-register hotkeys after settings close
        registerHotkeys();
    });
}

function registerHotkeys() {
    // Unregister all first
    globalShortcut.unregisterAll();

    if (!store.get('heidiCopyEnabled')) return;

    const hpiKey = store.get('hpiHotkey');
    const apKey = store.get('apHotkey');

    // Register HPI hotkey
    try {
        globalShortcut.register(hpiKey, () => {
            extractAndCopySection('hpi');
        });
    } catch (e) {
        console.error('Failed to register HPI hotkey:', e);
    }

    // Register A&P hotkey
    try {
        globalShortcut.register(apKey, () => {
            extractAndCopySection('ap');
        });
    } catch (e) {
        console.error('Failed to register A&P hotkey:', e);
    }
}

function extractAndCopySection(section) {
    // Get current clipboard content (should be from Heidi after Ctrl+A, Ctrl+C)
    // Note: User needs to Ctrl+A, Ctrl+C in Heidi first, then press the hotkey
    // Or we can simulate it - but simulating keystrokes on Windows requires native modules

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
        // Notify the renderer
        if (mainWindow) {
            mainWindow.webContents.send('section-copied', section);
        }
    }
}

function extractHPI(text) {
    // Find HPI start
    let hpiStart = -1;
    let usedHeader = '';

    for (const header of HPI_HEADERS) {
        const idx = text.indexOf(header);
        if (idx !== -1) {
            hpiStart = idx + header.length;
            usedHeader = header;
            break;
        }
    }

    if (hpiStart === -1) return null;

    // Find A&P (end of HPI)
    const apStart = text.indexOf(AP_HEADER);
    if (apStart === -1 || apStart <= hpiStart) return null;

    let extracted = text.substring(hpiStart, apStart);
    return cleanUpText(extracted);
}

function extractAP(text) {
    const apStart = text.indexOf(AP_HEADER);
    if (apStart === -1) return null;

    let extracted = text.substring(apStart + AP_HEADER.length);
    return cleanUpText(extracted);
}

function cleanUpText(text) {
    // Strip asterisks (NOT convert to caps)
    let cleaned = text.replace(/\*\*/g, '').replace(/\*/g, '');

    // Trim whitespace
    cleaned = cleaned.trim();

    // Remove leading blank lines
    const lines = cleaned.split('\n');
    let startIdx = 0;
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].trim()) {
            startIdx = i;
            break;
        }
    }
    cleaned = lines.slice(startIdx).join('\n');

    return cleaned;
}

// IPC handlers
ipcMain.handle('get-settings', () => {
    return {
        hpiHotkey: store.get('hpiHotkey'),
        apHotkey: store.get('apHotkey'),
        heidiCopyEnabled: store.get('heidiCopyEnabled'),
        customClaudeInstructions: store.get('customClaudeInstructions'),
        customAttestationTemplate: store.get('customAttestationTemplate')
    };
});

ipcMain.handle('save-settings', (event, settings) => {
    store.set('hpiHotkey', settings.hpiHotkey);
    store.set('apHotkey', settings.apHotkey);
    store.set('heidiCopyEnabled', settings.heidiCopyEnabled);
    store.set('customClaudeInstructions', settings.customClaudeInstructions);
    store.set('customAttestationTemplate', settings.customAttestationTemplate);
    registerHotkeys();
    return true;
});

ipcMain.handle('call-claude-api', async (event, text) => {
    const customInstructions = store.get('customClaudeInstructions');
    return await callClaudeAPI(text, customInstructions);
});

ipcMain.handle('get-attestation-template', () => {
    const custom = store.get('customAttestationTemplate');
    if (custom && custom.trim()) {
        return custom;
    }
    return DEFAULT_ATTESTATION_TEMPLATE;
});

// Claude API
const API_KEY = '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';

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
- Use dash-space bullets (- )
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
    let systemPrompt = BASE_SYSTEM_PROMPT;
    if (customInstructions && customInstructions.trim()) {
        systemPrompt += '\n\nADDITIONAL INSTRUCTIONS:\n' + customInstructions;
    }

    try {
        const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': API_KEY,
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

// App lifecycle
app.whenReady().then(() => {
    createMainWindow();
    registerHotkeys();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createMainWindow();
        }
    });
});

app.on('window-all-closed', () => {
    globalShortcut.unregisterAll();
    app.quit();
});

app.on('will-quit', () => {
    globalShortcut.unregisterAll();
});
