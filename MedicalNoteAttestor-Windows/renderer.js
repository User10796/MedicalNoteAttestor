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

// Plan type codes and their text
const PLAN_TYPES = {
    NO_CHANGES: 'ongoing plan of care as previously established by me',
    MED_CHANGES: 'new plan of care including changes to prescription medication',
    MED_AND_SCHEDULED: 'new plan of care including changes to prescription medication and the scheduled procedure',
    PROCEDURE_TODAY: 'new plan of care including the procedure performed today'
};

// Load settings and update UI
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

// Listen for section copied events from main process
window.electronAPI.onSectionCopied((section) => {
    const sectionName = section === 'hpi' ? 'HPI' : 'A&P';
    heidiStatus.textContent = `✓ ${sectionName} copied to clipboard`;
    heidiStatus.className = 'status success';

    // Clear status after 3 seconds
    setTimeout(() => {
        heidiStatus.textContent = '';
        heidiStatus.className = 'status';
    }, 3000);
});

// Select/Process button - reads from clipboard and processes
selectBtn.addEventListener('click', async () => {
    try {
        // Read from clipboard
        const clipboardText = await navigator.clipboard.readText();

        if (!clipboardText || !clipboardText.trim()) {
            setStatus('No text in clipboard. Copy text from Heidi first.', 'error');
            return;
        }

        setStatus('Processing with Claude API...', '');
        setLoading(true);
        outputArea.textContent = 'Processing...';

        const result = await window.electronAPI.callClaudeAPI(clipboardText);

        if (!result.success) {
            setStatus(`Error: ${result.error}`, 'error');
            outputArea.textContent = `Error: ${result.error}`;
            setLoading(false);
            return;
        }

        // Build full attestation
        const template = await window.electronAPI.getAttestationTemplate();
        const finalText = buildAttestation(result.text, template);

        outputArea.textContent = finalText;
        setStatus('Complete', 'success');

        // Auto-copy if enabled
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
    outputArea.textContent = 'Paste text from Heidi and click "Paste & Process" to format...';
    setStatus('', '');
});

async function copyToClipboard() {
    try {
        await navigator.clipboard.writeText(outputArea.textContent);
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
    // Extract plan type
    const planType = extractPlanType(claudeResponse);
    const dynamicText = PLAN_TYPES[planType] || PLAN_TYPES.NO_CHANGES;

    // Clean up bullets
    const cleanedBullets = cleanUpBullets(claudeResponse);

    // Replace placeholder in template
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
    if (hasScheduled) return 'MED_AND_SCHEDULED';  // If scheduled, assume some changes
    if (hasMedChanges) return 'MED_CHANGES';
    return 'NO_CHANGES';
}

function cleanUpBullets(text) {
    let lines = text.split('\n');

    // Remove code lines and empty lines
    lines = lines.filter(line => {
        const trimmed = line.trim();
        return trimmed && !trimmed.startsWith('[CODE:');
    });

    // Normalize bullets
    lines = lines.map(line => {
        let trimmed = line.trim();

        if (trimmed.startsWith('- ')) return trimmed;

        // Remove other bullet styles
        const bulletPrefixes = ['• ', '* ', '– ', '— ', '· '];
        for (const prefix of bulletPrefixes) {
            if (trimmed.startsWith(prefix)) {
                trimmed = trimmed.slice(prefix.length);
                break;
            }
        }

        // Remove numbered prefixes
        trimmed = trimmed.replace(/^\d+[\.\)]\s*/, '');

        return '- ' + trimmed;
    });

    return lines.join('\n');
}
