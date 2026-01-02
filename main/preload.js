const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    onMainChanged: (cb) => {
        if (!ipcRenderer) return;
        ipcRenderer.on('main-changed', (_, payload) => cb && cb(payload));
    },
    restartMain: () => ipcRenderer.invoke('restart-main'),
});
