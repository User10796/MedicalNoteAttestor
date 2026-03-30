const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    getSettings: () => ipcRenderer.invoke('get-settings'),
    saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
    callClaudeAPI: (text) => ipcRenderer.invoke('call-claude-api', text),
    getAttestationTemplate: () => ipcRenderer.invoke('get-attestation-template'),
    startScreenCapture: () => ipcRenderer.invoke('start-screen-capture'),
    copyToClipboard: (text) => ipcRenderer.invoke('copy-to-clipboard', text),
    onSectionCopied: (callback) => ipcRenderer.on('section-copied', (event, section) => callback(section)),
    onHotkeyStatus: (callback) => ipcRenderer.on('hotkey-status', (event, status) => callback(status)),
    getSlotState:        () => ipcRenderer.invoke('get-slot-state'),
    triggerCapture:      () => ipcRenderer.invoke('trigger-capture'),
    pasteSlot:           (name) => ipcRenderer.invoke('paste-slot', name),
    clearSlots:          () => ipcRenderer.invoke('clear-slots'),
    saveExamDotPhrase:   (text) => ipcRenderer.invoke('save-exam-dot-phrase', text),
    onCaptureResult:     (cb) => ipcRenderer.on('capture-result', (e, d) => cb(d)),
    onSlotPasted:        (cb) => ipcRenderer.on('slot-pasted', (e, n) => cb(n)),
    onSlotEmpty:         (cb) => ipcRenderer.on('slot-empty', (e, n) => cb(n)),
    onBulletsReady:      (cb) => ipcRenderer.on('bullets-ready', (e, d) => cb(d))
});
