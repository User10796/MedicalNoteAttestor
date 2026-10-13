const { contextBridge, ipcRenderer } = require('electron');

// Claude fill progress window: receives stages; Cancel publishes the slots with library text unfilled.
contextBridge.exposeInMainWorld('fillProgressAPI', {
    onProgress: (cb) => ipcRenderer.on('fill-progress', (e, p) => cb(p)),
    cancel: () => ipcRenderer.send('fill-cancel'),
    close: () => ipcRenderer.send('fill-progress-close')
});
