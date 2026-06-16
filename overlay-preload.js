const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('overlayAPI', {
    setScreenshot: (callback) => ipcRenderer.on('set-screenshot', (e, dataUrl) => callback(dataUrl)),
    selectionDone: (rect) => ipcRenderer.send('selection-done', rect),
    selectionCancel: () => ipcRenderer.send('selection-cancel')
});
