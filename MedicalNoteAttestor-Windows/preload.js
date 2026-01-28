const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    getSettings: () => ipcRenderer.invoke('get-settings'),
    saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
    callClaudeAPI: (text) => ipcRenderer.invoke('call-claude-api', text),
    getAttestationTemplate: () => ipcRenderer.invoke('get-attestation-template'),
    onSectionCopied: (callback) => ipcRenderer.on('section-copied', (event, section) => callback(section))
});
