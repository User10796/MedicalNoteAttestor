const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pickerAPI', {
    onInit: (cb) => ipcRenderer.on('picker-init', (e, data) => cb(data)),
    done: (answer) => ipcRenderer.send('picker-done', answer)   // null = Skip
});
