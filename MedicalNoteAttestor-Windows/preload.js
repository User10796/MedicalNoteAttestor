const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    getSettings: () => ipcRenderer.invoke('get-settings'),
    saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
    callClaudeAPI: (text) => ipcRenderer.invoke('call-claude-api', text),
    getAttestationTemplate: () => ipcRenderer.invoke('get-attestation-template'),
    startScreenCapture: () => ipcRenderer.invoke('start-screen-capture'),
    copyToClipboard: (text) => ipcRenderer.invoke('copy-to-clipboard', text),
    onSectionCopied: (callback) => ipcRenderer.on('section-copied', (event, section) => callback(section)),
    onHotkeyStatus: (callback) => ipcRenderer.on('hotkey-status', (event, status) => callback(status))
});
