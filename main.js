'use strict';

const { app, BrowserWindow, Menu, ipcMain, dialog, shell } = require('electron');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');

const APP_TITLE = 'Численные методы';
const APP_FILE = path.join(__dirname, 'app', 'index.html');
const NOTES_DIR = process.env.NN_NOTES_DIR
  ? path.resolve(process.env.NN_NOTES_DIR)
  : path.join(app.getPath('documents'), 'Численные методы');
const STATE_FILE = path.join(app.getPath('userData'), 'window-state.json');

let win = null;

/* ------------------------------------------------------------------ */
/*  Вспомогательные функции                                            */
/* ------------------------------------------------------------------ */

function safeTitle(title) {
  let name = String(title == null ? '' : title)
    .replace(/[\\/:*?"<>|\r\n\t]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '')
    .slice(0, 80);
  return name || 'Без названия';
}

function notePath(id) {
  const base = path.basename(String(id || ''));
  if (!base || base !== String(id) || !base.toLowerCase().endsWith('.md')) {
    throw new Error('Некорректное имя файла: ' + id);
  }
  return path.join(NOTES_DIR, base);
}

async function ensureNotesDir() {
  let firstRun = false;
  try {
    await fs.access(NOTES_DIR);
  } catch {
    firstRun = true;
    await fs.mkdir(NOTES_DIR, { recursive: true });
  }

  if (firstRun) {
    try {
      const starter = await fs.readFile(path.join(__dirname, 'app', 'starter.md'), 'utf8');
      await fs.writeFile(path.join(NOTES_DIR, 'Численные методы.md'), starter, 'utf8');
    } catch (err) {
      console.error('Не удалось создать стартовый конспект:', err);
    }
  }
}

async function listNotes() {
  await ensureNotesDir();
  const entries = await fs.readdir(NOTES_DIR, { withFileTypes: true });
  const notes = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue;
    const full = path.join(NOTES_DIR, entry.name);
    try {
      const stat = await fs.stat(full);
      notes.push({
        id: entry.name,
        title: entry.name.replace(/\.md$/i, ''),
        updated: stat.mtimeMs,
        size: stat.size
      });
    } catch {
      /* файл могли удалить в процессе чтения */
    }
  }
  notes.sort((a, b) => b.updated - a.updated);
  return notes;
}

async function uniqueNotePath(title, ignoreId) {
  const base = safeTitle(title);
  let candidate = base + '.md';
  let n = 2;
  while (true) {
    if (ignoreId && candidate.toLowerCase() === String(ignoreId).toLowerCase()) {
      return path.join(NOTES_DIR, candidate);
    }
    try {
      await fs.access(path.join(NOTES_DIR, candidate));
      candidate = `${base} (${n++}).md`;
    } catch {
      return path.join(NOTES_DIR, candidate);
    }
  }
}

async function createNote(title) {
  await ensureNotesDir();
  const full = await uniqueNotePath(title || 'Новый конспект');
  if (!fsSync.existsSync(full)) {
    await fs.writeFile(full, '# ' + path.basename(full, '.md') + '\n\n', 'utf8');
  }
  const stat = await fs.stat(full);
  return {
    id: path.basename(full),
    title: path.basename(full, '.md'),
    updated: stat.mtimeMs
  };
}

function loadWindowState() {
  try {
    return JSON.parse(fsSync.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { width: 1440, height: 920 };
  }
}

function saveWindowState() {
  if (!win) return;
  try {
    const bounds = win.getNormalBounds();
    fsSync.writeFileSync(STATE_FILE, JSON.stringify(bounds), 'utf8');
  } catch {
    /* не критично */
  }
}

/* ------------------------------------------------------------------ */
/*  Меню                                                               */
/* ------------------------------------------------------------------ */

function send(action, payload) {
  if (win && !win.isDestroyed()) win.webContents.send('menu:action', action, payload);
}

function buildMenu() {
  const template = [
    {
      label: 'Файл',
      submenu: [
        { label: 'Новый конспект', accelerator: 'CmdOrCtrl+N', click: () => send('new-note') },
        { label: 'Сохранить', accelerator: 'CmdOrCtrl+S', click: () => send('save') },
        { type: 'separator' },
        { label: 'Экспорт в PDF…', accelerator: 'CmdOrCtrl+E', click: () => send('export-pdf') },
        { type: 'separator' },
        {
          label: 'Открыть папку с конспектами',
          click: () => shell.openPath(NOTES_DIR)
        },
        { type: 'separator' },
        { role: 'quit', label: 'Выход' }
      ]
    },
    {
      label: 'Правка',
      submenu: [
        { role: 'undo', label: 'Отменить' },
        { role: 'redo', label: 'Повторить' },
        { type: 'separator' },
        { role: 'cut', label: 'Вырезать' },
        { role: 'copy', label: 'Копировать' },
        { role: 'paste', label: 'Вставить' },
        { role: 'selectAll', label: 'Выделить всё' },
        { type: 'separator' },
        { label: 'Найти в тексте…', accelerator: 'CmdOrCtrl+F', click: () => send('find') }
      ]
    },
    {
      label: 'Вставка',
      submenu: [
        { label: 'Формула в строке', accelerator: 'CmdOrCtrl+M', click: () => send('insert-inline-math') },
        { label: 'Формула отдельной строкой', accelerator: 'CmdOrCtrl+Shift+M', click: () => send('insert-block-math') },
        { label: 'График', accelerator: 'CmdOrCtrl+Shift+P', click: () => send('insert-plot') },
        { label: 'Таблица', accelerator: 'CmdOrCtrl+Shift+T', click: () => send('insert-table') },
        { type: 'separator' },
        { label: 'Палитра формул', accelerator: 'CmdOrCtrl+Shift+K', click: () => send('toggle-palette') },
        { label: 'Конструктор записи…', accelerator: 'CmdOrCtrl+Shift+B', click: () => send('builder') },
        { label: 'Калькулятор', accelerator: 'CmdOrCtrl+Shift+C', click: () => send('calculator') }
      ]
    },
    {
      label: 'Вид',
      submenu: [
        { label: 'Только редактор', accelerator: 'CmdOrCtrl+1', click: () => send('mode-edit') },
        { label: 'Редактор и просмотр', accelerator: 'CmdOrCtrl+2', click: () => send('mode-split') },
        { label: 'Только чтение', accelerator: 'CmdOrCtrl+3', click: () => send('mode-read') },
        { type: 'separator' },
        { label: 'Светлая / тёмная тема', accelerator: 'CmdOrCtrl+Shift+L', click: () => send('toggle-theme') },
        { type: 'separator' },
        { role: 'reload', label: 'Перезагрузить' },
        { role: 'toggleDevTools', label: 'Инструменты разработчика' }
      ]
    },
    {
      label: 'Справка',
      submenu: [
        { label: 'Шпаргалка (F1)', accelerator: 'F1', click: () => send('help') },
        {
          label: 'О программе',
          click: () => {
            dialog.showMessageBox(win, {
              type: 'info',
              title: 'О программе',
              message: APP_TITLE,
              detail:
                'Конспекты с формулами и графиками.\n\n' +
                'Формулы — KaTeX (LaTeX), текст — Markdown.\n' +
                'Файлы сохраняются в папку «Документы\\Численные методы».',
              buttons: ['OK']
            });
          }
        }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ------------------------------------------------------------------ */
/*  Окно                                                               */
/* ------------------------------------------------------------------ */

function createWindow() {
  const bounds = loadWindowState();
  const iconPath = path.join(__dirname, 'app', 'icon.png');

  win = new BrowserWindow({
    x: Number.isFinite(bounds.x) ? bounds.x : undefined,
    y: Number.isFinite(bounds.y) ? bounds.y : undefined,
    width: Math.max(900, bounds.width || 1440),
    height: Math.max(600, bounds.height || 920),
    minWidth: 860,
    minHeight: 560,
    backgroundColor: '#0c0f15',
    title: APP_TITLE,
    icon: fsSync.existsSync(iconPath) ? iconPath : undefined,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false
    }
  });

  win.loadFile(APP_FILE);

  if (process.env.NN_SMOKE) {
    const logs = [];
    win.webContents.on('console-message', (...args) => {
      const details = args[1] && typeof args[1] === 'object' ? args[1] : null;
      logs.push(details ? { level: details.level, message: details.message } : { level: args[1], message: args[2] });
    });
    win.webContents.on('preload-error', (_event, preloadPath, error) => {
      logs.push({ level: 'preload-error', message: preloadPath + ': ' + error.message });
    });
    win.webContents.on('render-process-gone', (_event, details) => {
      logs.push({ level: 'gone', message: JSON.stringify(details) });
    });

    const testMd = [
      '# Тест формул',
      '',
      'Индекс $x_i^{2}$ и дробь $\\frac{a}{b}$.',
      '',
      '$$',
      '\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}',
      '$$',
      '',
      '| a | b |',
      '| --- | --- |',
      '| 1 | 2 |',
      '',
      '```plot',
      'f(x) = sin(x)',
      'x: -6..6',
      'title: Синус',
      '```',
      '',
      '```plot',
      'f(x) = sin(',
      '```',
      ''
    ].join('\n');

    win.webContents.once('did-finish-load', async () => {
      win.showInactive();
      await new Promise((resolve) => setTimeout(resolve, 400));

      const initialScript = `(async () => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        for (let i = 0; i < 80; i++) {
          if (document.querySelector('#preview h1')) break;
          await sleep(100);
        }
        await sleep(600);
        const count = (sel) => document.querySelectorAll(sel).length;
        return {
          title: (document.querySelector('#note-title') || {}).value,
          notes: count('.note-item'),
          previewH1: count('#preview h1'),
          katex: count('#preview .katex'),
          plots: count('#preview .plot-canvas canvas'),
          plotErrors: count('#preview .plot-error'),
          mathErrors: count('#preview .math-error'),
          tables: count('#preview table'),
          status: (document.querySelector('#save-status') || {}).textContent,
          editorChars: ((document.querySelector('#editor') || {}).value || '').length,
          paletteButtons: count('#palette .palette-btn')
        };
      })()`;

      const interactionScript = `(async () => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const $ = (sel) => document.querySelector(sel);
        const count = (sel) => document.querySelectorAll(sel).length;
        const result = {};

        $('#btn-new').click();
        await sleep(900);
        result.afterNew = {
          title: $('#note-title').value,
          notes: count('.note-item'),
          editorChars: $('#editor').value.length
        };

        const editor = $('#editor');
        editor.value = ${JSON.stringify(testMd)};
        editor.dispatchEvent(new Event('input', { bubbles: true }));
        await sleep(1900);

        result.afterType = {
          katex: count('#preview .katex'),
          plots: count('#preview .plot-canvas canvas'),
          plotErrors: count('#preview .plot-error'),
          tables: count('#preview table'),
          status: $('#save-status').textContent
        };

        editor.focus();
        editor.setSelectionRange(editor.value.length, editor.value.length);
        $('[data-before="^{"]').click();
        result.superscriptTail = editor.value.slice(-14);

        $('#btn-palette').click();
        await sleep(250);
        result.paletteOpen = !$('#palette').classList.contains('hidden');
        result.paletteButtons = count('#palette .palette-btn');
        $('#palette-tabs [data-tab="methods"]').click();
        await sleep(250);
        result.methodButtons = count('#palette .method-btn');
        $('#palette-close').click();

        $('.view-switch [data-mode="read"]').click();
        await sleep(350);
        result.readModeEditorDisplay = getComputedStyle($('#editor-pane')).display;
        result.readModePreviewDisplay = getComputedStyle($('#preview-pane')).display;

        $('.view-switch [data-mode="split"]').click();
        await sleep(250);

        $('#btn-theme').click();
        await sleep(350);
        result.lightTheme = document.body.classList.contains('light');
        $('#btn-theme').click();
        await sleep(350);

        await sleep(900);
        result.finalStatus = $('#save-status').textContent;
        result.notesAfterSave = count('.note-item');
        return result;
      })()`;

      try {
        const initial = await win.webContents.executeJavaScript(initialScript);

        try {
          const image = await win.capturePage();
          await fs.writeFile(path.join(__dirname, 'smoke-initial.png'), image.toPNG());
        } catch (err) {
          logs.push({ level: 'capture', message: err.message });
        }

        const interaction = await win.webContents.executeJavaScript(interactionScript);

        try {
          await new Promise((resolve) => setTimeout(resolve, 500));
          const image = await win.capturePage();
          await fs.writeFile(path.join(__dirname, 'smoke-after.png'), image.toPNG());
        } catch (err) {
          logs.push({ level: 'capture', message: err.message });
        }

        let pdfBytes = 0;
        try {
          const pdf = await win.webContents.printToPDF({ printBackground: true, pageSize: 'A4' });
          pdfBytes = pdf.length;
          await fs.writeFile(path.join(__dirname, 'smoke.pdf'), pdf);
        } catch (err) {
          logs.push({ level: 'pdf', message: err.message });
        }

        console.log('SMOKE_RESULT ' + JSON.stringify({ initial, interaction, pdfBytes, logs }, null, 2));
      } catch (err) {
        console.log('SMOKE_ERROR ' + err.message);
        console.log('SMOKE_LOGS ' + JSON.stringify(logs));
      }
      app.quit();
    });
  }

  win.once('ready-to-show', () => {
    if (!process.env.NN_SMOKE) win.show();
    if (process.argv.includes('--dev')) win.webContents.openDevTools({ mode: 'detach' });
  });

  win.on('close', saveWindowState);
  win.on('closed', () => {
    win = null;
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^(https?|mailto):/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (event, url) => {
    /* Перезагрузка и якоря внутри приложения — можно.
       Любые другие переходы (в т.ч. file:// из ссылок в конспекте) блокируем. */
    let target = '';
    try {
      target = path.resolve(fileURLToPath(url));
    } catch {
      target = '';
    }

    if (target === APP_FILE) return;
    event.preventDefault();
    if (/^(https?|mailto):/i.test(url)) shell.openExternal(url);
  });
}

/* ------------------------------------------------------------------ */
/*  IPC                                                                */
/* ------------------------------------------------------------------ */

ipcMain.handle('notes:list', () => listNotes());

ipcMain.handle('notes:read', async (_event, id) => {
  const full = notePath(id);
  const [content, stat] = await Promise.all([fs.readFile(full, 'utf8'), fs.stat(full)]);
  return {
    id: path.basename(full),
    title: path.basename(full, '.md'),
    content,
    updated: stat.mtimeMs
  };
});

ipcMain.handle('notes:save', async (_event, id, content) => {
  const full = notePath(id);
  await fs.writeFile(full, String(content == null ? '' : content), 'utf8');
  const stat = await fs.stat(full);
  return { id: path.basename(full), updated: stat.mtimeMs };
});

ipcMain.handle('notes:create', (_event, title) => createNote(title));

ipcMain.handle('notes:rename', async (_event, id, title) => {
  const oldFull = notePath(id);
  const newFull = await uniqueNotePath(title, id);
  if (oldFull.toLowerCase() !== newFull.toLowerCase()) {
    await fs.rename(oldFull, newFull);
  } else if (oldFull !== newFull) {
    // сменился только регистр — переименовываем через временный файл
    const tmp = oldFull + '.tmp-rename';
    await fs.rename(oldFull, tmp);
    await fs.rename(tmp, newFull);
  }
  return {
    id: path.basename(newFull),
    title: path.basename(newFull, '.md')
  };
});

ipcMain.handle('notes:delete', async (_event, id) => {
  const full = notePath(id);
  try {
    await shell.trashItem(full);
  } catch {
    await fs.unlink(full);
  }
  return true;
});

ipcMain.handle('notes:open-dir', async () => {
  await ensureNotesDir();
  return shell.openPath(NOTES_DIR);
});

ipcMain.handle('notes:dir', () => NOTES_DIR);

ipcMain.handle('export-pdf', async (_event, suggestedName) => {
  const name = safeTitle(suggestedName || 'Конспект');
  const result = await dialog.showSaveDialog(win, {
    title: 'Экспорт в PDF',
    defaultPath: path.join(app.getPath('documents'), name + '.pdf'),
    filters: [{ name: 'PDF', extensions: ['pdf'] }]
  });
  if (result.canceled || !result.filePath) return null;

  const pdf = await win.webContents.printToPDF({
    printBackground: true,
    pageSize: 'A4',
    margins: { marginType: 'custom', top: 0.55, bottom: 0.55, left: 0.6, right: 0.6 }
  });
  await fs.writeFile(result.filePath, pdf);
  return result.filePath;
});

/* ------------------------------------------------------------------ */
/*  Запуск                                                             */
/* ------------------------------------------------------------------ */

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(async () => {
    await ensureNotesDir();
    buildMenu();
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
