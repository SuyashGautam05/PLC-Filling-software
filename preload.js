const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('plcAPI', {
  connect: (config) => ipcRenderer.invoke('modbus:connect', config),
  disconnect: () => ipcRenderer.invoke('modbus:disconnect'),
  readOnce: () => ipcRenderer.invoke('modbus:readOnce'),
  startPolling: (config) => ipcRenderer.invoke('modbus:startPolling', config),
  stopPolling: () => ipcRenderer.invoke('modbus:stopPolling'),

  start: () => ipcRenderer.invoke('modbus:start'),
  stop: () => ipcRenderer.invoke('modbus:stop'),
  setQuantity: (value) => ipcRenderer.invoke('modbus:setQuantity', value),
  setFillingDirection: (direction) => ipcRenderer.invoke('modbus:setFillingDirection', direction),
  writeBit: (target, value) => ipcRenderer.invoke('modbus:writeBit', { target, value }),
  saveImage: (dataUrl) => ipcRenderer.invoke('camera:saveImage', dataUrl),
  resetCounts: () => ipcRenderer.invoke('camera:resetCounts'),

  readOEE: () => ipcRenderer.invoke('modbus:readOEE'),
  resetOEE: () => ipcRenderer.invoke('modbus:resetOEE'),

  getReportSummary: () => ipcRenderer.invoke('reports:getSummary'),
  downloadReport: () => ipcRenderer.invoke('reports:download'),

  onData: (callback) => {
    ipcRenderer.removeAllListeners('modbus:data');
    ipcRenderer.on('modbus:data', (event, data) => callback(data));
  },
  onCameraTrigger: (callback) => {
    ipcRenderer.removeAllListeners('camera:trigger');
    ipcRenderer.on('camera:trigger', (event, data) => callback(data));
  },
});