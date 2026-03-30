// DOM Elements
const selectBtn = document.getElementById('select-btn');
const copyBtn = document.getElementById('copy-btn');
const clearBtn = document.getElementById('clear-btn');
const autoCopyCheckbox = document.getElementById('auto-copy');
const outputArea = document.getElementById('output');
const statusDiv = document.getElementById('status');
const spinner = document.getElementById('spinner');
const hpiKeySpan = document.getElementById('hpi-key');
const apKeySpan = document.getElementById('ap-key');
const heidiStatus = document.getElementById('heidi-status');

// Tab switching
const tabs = document.querySelectorAll('.tab');
const tabContents = document.querySelectorAll('.tab-content');

tabs.forEach(tab => {
    tab.addEventListener('click', () => {
        const tabId = tab.dataset.tab;
        tabs.forEach(t => t.classList.remove('active'));
        tabContents.forEach(c => c.classList.remove('active'));
        tab.classList.add('active');
        document.getElementById(`${tabId}-tab`).classList.add('active');
    });
});

// Plan type codes
const PLAN_TYPES = {
    NO_CHANGES: 'ongoing plan of care as previously established by me',
    MED_CHANGES: 'new plan of care including changes to prescription medication',
    MED_AND_SCHEDULED: 'new plan of care including changes to prescription medication and the scheduled procedure',
    PROCEDURE_TODAY: 'new plan of care including the procedure performed today'
};

// Load settings
async function loadSettings() {
    try {
        const settings = await window.electronAPI.getSettings();
        hpiKeySpan.textContent = settings.hpiHotkey;
        apKeySpan.textContent = settings.apHotkey;
    } catch (e) {
        console.error('Failed to load settings:', e);
    }
}

loadSettings();

// Hotkey registration status
window.electronAPI.onHotkeyStatus((status) => {
    console.log('Hotkey status:', status);
    if (!status.registered) {
        heidiStatus.textContent = 'Hotkeys disabled in settings';
        heidiStatus.className = 'status error';
    } else {
        const msgs = [];
        if (!status.hpiOk) msgs.push(`HPI (${status.hpiKey}) FAILED to register`);
        if (!status.apOk) msgs.push(`A&P (${status.apKey}) FAILED to register`);
        if (msgs.length > 0) {
            heidiStatus.textContent = '⚠ ' + msgs.join(', ');
            heidiStatus.className = 'status error';
        } else {
            heidiStatus.textContent = `✓ Hotkeys active: ${status.hpiKey} (HPI), ${status.apKey} (A&P)`;
            heidiStatus.className = 'status success';
        }
    }
});

// Heidi copy events
window.electronAPI.onSectionCopied((section) => {
    const sectionName = section === 'hpi' ? 'HPI' : 'A&P';
    heidiStatus.textContent = `✓ ${sectionName} copied to clipboard`;
    heidiStatus.className = 'status success';
    setTimeout(() => {
        heidiStatus.textContent = '';
        heidiStatus.className = 'status';
    }, 3000);
});

// ── Tesseract.js OCR (loaded dynamically) ─────────────────────────────────

let tesseractLoaded = false;
let Tesseract = null;

async function loadTesseract() {
    if (tesseractLoaded) return;
    return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
        script.onload = () => {
            Tesseract = window.Tesseract;
            tesseractLoaded = true;
            resolve();
        };
        script.onerror = () => reject(new Error('Failed to load Tesseract.js. Check your internet connection.'));
        document.head.appendChild(script);
    });
}

async function performOCR(imageDataUrl) {
    await loadTesseract();
    const worker = await Tesseract.createWorker('eng');
    const { data: { text } } = await worker.recognize(imageDataUrl);
    await worker.terminate();
    return text;
}

// ── Select button: screen capture → OCR → Claude API ──────────────────────

selectBtn.addEventListener('click', async () => {
    try {
        // Clear output
        outputArea.textContent = 'Select a region on screen...';
        setStatus('Drag to select text area', '');

        // Start screen capture (main process handles overlay)
        const captureResult = await window.electronAPI.startScreenCapture();

        if (!captureResult.success) {
            if (captureResult.cancelled) {
                outputArea.textContent = "Click 'Select' to capture screen text...";
                setStatus('', '');
            } else {
                setStatus(`Capture error: ${captureResult.error}`, 'error');
                outputArea.textContent = `Error: ${captureResult.error}`;
            }
            return;
        }

        // OCR the captured image
        setStatus('Extracting text (OCR)...', '');
        setLoading(true);

        const ocrText = await performOCR(captureResult.imageDataUrl);

        if (!ocrText || !ocrText.trim()) {
            setStatus('No text found in selection.', 'error');
            outputArea.textContent = 'No text found in selected region.';
            setLoading(false);
            return;
        }

        // Send to Claude API
        setStatus('Processing with Claude API...', '');
        outputArea.textContent = 'Processing...';

        const result = await window.electronAPI.callClaudeAPI(ocrText);

        if (!result.success) {
            setStatus(`Error: ${result.error}`, 'error');
            outputArea.textContent = `Error: ${result.error}`;
            setLoading(false);
            return;
        }

        // Build attestation
        const template = await window.electronAPI.getAttestationTemplate();
        const finalText = buildAttestation(result.text, template);

        outputArea.textContent = finalText;
        setStatus('Complete', 'success');

        if (autoCopyCheckbox.checked) {
            await copyToClipboard();
            setStatus('Complete - Copied to clipboard', 'success');
        }
    } catch (error) {
        setStatus(`Error: ${error.message}`, 'error');
        outputArea.textContent = `Error: ${error.message}`;
    } finally {
        setLoading(false);
    }
});

// Copy button
copyBtn.addEventListener('click', async () => {
    await copyToClipboard();
});

// Clear button
clearBtn.addEventListener('click', () => {
    outputArea.textContent = "Click 'Select' to capture screen text...";
    setStatus('', '');
});

async function copyToClipboard() {
    try {
        await window.electronAPI.copyToClipboard(outputArea.textContent);
        setStatus('Copied to clipboard', 'success');
    } catch (error) {
        setStatus('Failed to copy', 'error');
    }
}

function setStatus(message, type) {
    statusDiv.textContent = message;
    statusDiv.className = 'status' + (type ? ` ${type}` : '');
}

function setLoading(loading) {
    spinner.style.display = loading ? 'block' : 'none';
    selectBtn.disabled = loading;
}

function buildAttestation(claudeResponse, template) {
    const planType = extractPlanType(claudeResponse);
    const dynamicText = PLAN_TYPES[planType] || PLAN_TYPES.NO_CHANGES;
    const cleanedBullets = cleanUpBullets(claudeResponse);
    const attestation = template.replace('[DYNAMIC_PLAN_TEXT]', dynamicText);
    return attestation + cleanedBullets;
}

function extractPlanType(text) {
    const lower = text.toLowerCase();

    if (text.includes('[CODE:PROCEDURE_TODAY]') ||
        lower.includes('performed today') ||
        lower.includes('procedure today')) {
        return 'PROCEDURE_TODAY';
    }

    const hasScheduled = text.includes('[CODE:MED_AND_SCHEDULED]') ||
        lower.includes('schedule ') ||
        lower.includes('scheduled ') ||
        lower.includes('scheduling ');

    const hasMedChanges = text.includes('[CODE:MED_CHANGES]') ||
        text.includes('[CODE:MED_AND_SCHEDULED]') ||
        lower.includes('- start:') ||
        lower.includes('- stop:') ||
        lower.includes('- change:');

    if (hasScheduled && hasMedChanges) return 'MED_AND_SCHEDULED';
    if (hasScheduled) return 'MED_AND_SCHEDULED';
    if (hasMedChanges) return 'MED_CHANGES';
    return 'NO_CHANGES';
}

function cleanUpBullets(text) {
    let lines = text.split('\n');

    lines = lines.filter(line => {
        const trimmed = line.trim();
        return trimmed && !trimmed.startsWith('[CODE:');
    });

    lines = lines.map(line => {
        let trimmed = line.trim();
        if (trimmed.startsWith('- ')) return trimmed;

        const bulletPrefixes = ['• ', '* ', '– ', '— ', '· '];
        for (const prefix of bulletPrefixes) {
            if (trimmed.startsWith(prefix)) {
                trimmed = trimmed.slice(prefix.length);
                break;
            }
        }

        trimmed = trimmed.replace(/^\d+[\.\)]\s*/, '');
        return '- ' + trimmed;
    });

    return lines.join('\n');
}
