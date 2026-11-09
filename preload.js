'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  listNotes: () => ipcRenderer.invoke('notes:list'),
  readNote: (id) => ipcRenderer.invoke('notes:read', id),
  saveNote: (id, content) => ipcRenderer.invoke('notes:save', id, content),
  createNote: (title) => ipcRenderer.invoke('notes:create', title),
  renameNote: (id, title) => ipcRenderer.invoke('notes:rename', id, title),
  deleteNote: (id) => ipcRenderer.invoke('notes:delete', id),
  openNotesDir: () => ipcRenderer.invoke('notes:open-dir'),
  notesDir: () => ipcRenderer.invoke('notes:dir'),
  exportPDF: (name) => ipcRenderer.invoke('export-pdf', name),
  onMenu: (callback) => {
    ipcRenderer.on('menu:action', (_event, action, payload) => callback(action, payload));
  }
});
