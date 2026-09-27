const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
    getSettings: () => ipcRenderer.invoke('settings:get'),
    setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
    loadData: (mode, force = false) => ipcRenderer.invoke('data:load', { mode, force }),
    getSvg: (url) => ipcRenderer.invoke('svg:get', url),
    pickFolder: (current) => ipcRenderer.invoke('dialog:folder', current),
    latestLocation: () => ipcRenderer.invoke('location:latest'),
    openExternal: (url) => ipcRenderer.invoke('shell:open', url),
    detectPaths: () => ipcRenderer.invoke('paths:detect'),
    on: (channel, cb) => {
        const allowed = ['position', 'map-detected', 'raid-ended', 'status'];
        if (!allowed.includes(channel)) return;
        ipcRenderer.on(channel, (e, payload) => cb(payload));
    },
});
