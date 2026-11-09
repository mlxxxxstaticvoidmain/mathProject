'use strict';

/* ================================================================== */
/*  Состояние                                                          */
/* ================================================================== */

const bridge = window.api;

const MODES = ['edit', 'split', 'read'];

function clampSplit(value) {
  const n = Number.parseFloat(value);
  if (!Number.isFinite(n)) return 0.5;
  return Math.min(0.8, Math.max(0.2, n));
}

const savedMode = localStorage.getItem('nn.mode');

const state = {
  notes: [],
  currentId: null,
  dirty: false,
  mode: MODES.includes(savedMode) ? savedMode : 'split',
  theme: localStorage.getItem('nn.theme') === 'light' ? 'light' : 'dark',
  saveTimer: null,
  renderTimer: null,
  titleTimer: null,
  split: clampSplit(localStorage.getItem('nn.split'))
};

let activePlots = [];
let saveChain = Promise.resolve();
let renamePromise = Promise.resolve();
let toastTimer = null;
let openSeq = 0;
let findState = { matches: [], index: -1, query: '' };

const els = {
  app: document.getElementById('app'),
  editor: document.getElementById('editor'),
  preview: document.getElementById('preview'),
  title: document.getElementById('note-title'),
  saveStatus: document.getElementById('save-status'),
  notesList: document.getElementById('notes-list'),
  search: document.getElementById('search'),
  statusWords: document.getElementById('stat-words'),
  statusCursor: document.getElementById('stat-cursor'),
  divider: document.getElementById('divider'),
  work: document.getElementById('work'),
  palette: document.getElementById('palette'),
  paletteBody: document.getElementById('palette-body'),
  paletteTabs: document.getElementById('palette-tabs'),
  helpModal: document.getElementById('help-modal'),
  toast: document.getElementById('toast'),
  findbar: document.getElementById('findbar'),
  findInput: document.getElementById('find-input'),
  findCount: document.getElementById('find-count'),
  builderModal: document.getElementById('builder-modal'),
  builderTabs: document.getElementById('builder-tabs'),
  builderList: document.getElementById('builder-list'),
  builderFields: document.getElementById('builder-fields'),
  builderPreview: document.getElementById('builder-preview'),
  builderInsert: document.getElementById('builder-insert'),
  builderInsertBlock: document.getElementById('builder-insert-block'),
  calc: document.getElementById('calc'),
  calcExpr: document.getElementById('calc-expr'),
  calcResult: document.getElementById('calc-result'),
  calcKeys: document.getElementById('calc-keys'),
  calcFuncs: document.querySelector('.calc-funcs'),
  calcHistory: document.getElementById('calc-history')
};

/* ================================================================== */
/*  Разметка: Markdown + математика + графики                          */
/* ================================================================== */

const MATH_MACROS = {
  '\\R': '\\mathbb{R}',
  '\\N': '\\mathbb{N}',
  '\\Z': '\\mathbb{Z}',
  '\\dd': '\\mathrm{d}',
  '\\eps': '\\varepsilon',
  '\\abs': '\\left|#1\\right|',
  '\\norm': '\\left\\|#1\\right\\|'
};

function renderTex(tex, display) {
  try {
    return katex.renderToString(String(tex).trim(), {
      displayMode: !!display,
      throwOnError: false,
      errorColor: '#ff6b81',
      strict: 'ignore',
      trust: false,
      macros: MATH_MACROS
    });
  } catch (err) {
    return '<span class="math-error" title="' + escapeHtml(err.message) + '">' + escapeHtml(tex) + '</span>';
  }
}

const MATH_RE = /(?<!\\)\$\$([\s\S]+?)(?<!\\)\$\$|(?<!\\)\\\[([\s\S]+?)\\\]|(?<!\\)\\\(([\s\S]+?)\\\)|(?<!\\)\$([^$\n]+?)(?<!\\)\$/g;

/* Служебные маркеры для уже отрендеренных формул/графиков.
   Символы из Private Use Area практически не встречаются в тексте,
   поэтому не конфликтуют с обычным содержимым конспекта. */
const TOKEN_OPEN = '\uE000';
const TOKEN_CLOSE = '\uE001';
const TOKEN_PARAGRAPH_RE = new RegExp('<p>\\s*' + TOKEN_OPEN + '(\\d+)' + TOKEN_CLOSE + '\\s*</p>', 'g');
const TOKEN_INLINE_RE = new RegExp(TOKEN_OPEN + '(\\d+)' + TOKEN_CLOSE, 'g');

function mathToken(index) {
  return TOKEN_OPEN + index + TOKEN_CLOSE;
}

function protectMath(segment, tokens) {
  /* инлайн-код не трогаем */
  const chunks = String(segment).split(/(`[^`\n]*`)/g);
  return chunks
    .map((chunk, index) => {
      if (index % 2 === 1) return chunk;

      return chunk.replace(MATH_RE, (match, d1, d2, i1, i2) => {
        const tex = d1 !== undefined ? d1 : d2 !== undefined ? d2 : i1 !== undefined ? i1 : i2;
        const display = d1 !== undefined || d2 !== undefined;
        tokens.push(renderTex(tex, display));
        const token = mathToken(tokens.length - 1);
        return display ? '\n\n' + token + '\n\n' : token;
      });
    })
    .join('');
}

function plotFigureHtml(body) {
  const encoded = encodeURIComponent(body).replace(/"/g, '&quot;');
  return (
    '<figure class="plot-figure">' +
    '<div class="plot-canvas" data-src="' + encoded + '"></div>' +
    '<figcaption></figcaption>' +
    '</figure>'
  );
}

function extractBlocks(source) {
  const tokens = [];
  const out = [];
  const fenceRe = /```([^\n`]*)\r?\n([\s\S]*?)```/g;
  let last = 0;
  let match;

  while ((match = fenceRe.exec(source))) {
    out.push(protectMath(source.slice(last, match.index), tokens));

    const lang = String(match[1] || '').trim().toLowerCase();
    const body = match[2];

    if (lang === 'plot' || lang === 'graph' || lang === 'chart') {
      tokens.push(plotFigureHtml(body));
      out.push('\n\n' + mathToken(tokens.length - 1) + '\n\n');
    } else if (lang === 'math' || lang === 'tex' || lang === 'latex') {
      tokens.push(renderTex(body, true));
      out.push('\n\n' + mathToken(tokens.length - 1) + '\n\n');
    } else {
      out.push(match[0]);
    }

    last = fenceRe.lastIndex;
  }

  out.push(protectMath(source.slice(last), tokens));
  return { text: out.join(''), tokens };
}

function renderMarkdown(source) {
  const { text, tokens } = extractBlocks(String(source || ''));

  let html = marked.parse(text, { gfm: true, breaks: false, async: false });
  if (typeof html !== 'string') html = String(html);

  html = DOMPurify.sanitize(html, {
    ADD_ATTR: ['target'],
    FORBID_TAGS: ['style', 'script', 'iframe', 'object', 'embed']
  });

  /* разворачиваем формулы и графики обратно */
  html = html.replace(TOKEN_PARAGRAPH_RE, (m, index) => tokens[Number(index)] || '');
  html = html.replace(TOKEN_INLINE_RE, (m, index) => tokens[Number(index)] || '');

  return html;
}

function mountPlots() {
  const nodes = els.preview.querySelectorAll('.plot-canvas[data-src]');

  nodes.forEach((node) => {
    let source = '';
    try {
      source = decodeURIComponent(node.dataset.src || '');
    } catch {
      source = '';
    }

    try {
      const plot = window.PlotLib.create(node, source);
      activePlots.push(plot);
    } catch (err) {
      node.innerHTML =
        '<div class="plot-error"><strong>Ошибка в графике</strong>' +
        escapeHtml(err.message || String(err)) +
        '<pre>' + escapeHtml(source) + '</pre></div>';
    }
  });
}

function renderPreview() {
  const scrollRatio =
    els.preview.scrollHeight > 0 ? els.preview.scrollTop / els.preview.scrollHeight : 0;

  activePlots.forEach((plot) => {
    try { plot.destroy(); } catch { /* ignore */ }
  });
  activePlots = [];

  try {
    els.preview.innerHTML = renderMarkdown(els.editor.value);
    mountPlots();
  } catch (err) {
    els.preview.innerHTML =
      '<div class="plot-error"><strong>Не удалось отобразить конспект</strong>' +
      escapeHtml(err.message || String(err)) +
      '</div>';
  }

  if (scrollRatio > 0) {
    els.preview.scrollTop = scrollRatio * els.preview.scrollHeight;
  }
}

/* ================================================================== */
/*  Служебное                                                          */
/* ================================================================== */

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function toast(message, isError) {
  els.toast.textContent = message;
  els.toast.classList.toggle('error', !!isError);
  els.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove('show'), 3400);
}

function setStatus(text, kind) {
  els.saveStatus.textContent = text;
  els.saveStatus.className = 'save-status' + (kind ? ' ' + kind : '');
}

function plural(number, forms) {
  const n = Math.abs(number) % 100;
  const n1 = n % 10;
  if (n > 10 && n < 20) return forms[2];
  if (n1 > 1 && n1 < 5) return forms[1];
  if (n1 === 1) return forms[0];
  return forms[2];
}

function formatDate(timestamp) {
  const date = new Date(timestamp);
  const now = new Date();
  const sameDay = (a, b) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();

  if (sameDay(date, now)) {
    return 'сегодня, ' + date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  }

  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(date, yesterday)) return 'вчера';

  if (date.getFullYear() === now.getFullYear()) {
    return date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
  }

  return date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' });
}

function updateStats() {
  const text = els.editor.value;
  const words = (text.match(/[^\s]+/g) || []).length;
  els.statusWords.textContent = words + ' ' + plural(words, ['слово', 'слова', 'слов']);

  const pos = els.editor.selectionStart;
  const before = text.slice(0, pos);
  const line = before.split('\n').length;
  const col = pos - before.lastIndexOf('\n');
  els.statusCursor.textContent = 'Стр ' + line + ', кол ' + col;
}

function updateWindowTitle() {
  const title = els.title.value.trim();
  document.title = (title ? title + ' — ' : '') + 'Численные методы';
}

/* ================================================================== */
/*  Тема и режим                                                       */
/* ================================================================== */

function applyTheme() {
  document.body.classList.toggle('light', state.theme === 'light');
  const btn = document.getElementById('btn-theme');
  if (btn) btn.textContent = state.theme === 'light' ? 'Тёмная' : 'Светлая';
  localStorage.setItem('nn.theme', state.theme);
}

function toggleTheme() {
  state.theme = state.theme === 'light' ? 'dark' : 'light';
  applyTheme();
  activePlots.forEach((plot) => {
    try { plot.redraw(); } catch { /* ignore */ }
  });
}

function applyMode(mode) {
  state.mode = mode || state.mode;
  els.app.className = 'mode-' + state.mode;

  document.querySelectorAll('.view-switch button').forEach((button) => {
    button.classList.toggle('active', button.dataset.mode === state.mode);
  });

  localStorage.setItem('nn.mode', state.mode);

  requestAnimationFrame(() => {
    els.preview.scrollTop = els.preview.scrollTop;
    activePlots.forEach((plot) => {
      try { plot.redraw(); } catch { /* ignore */ }
    });
  });
}

/* ================================================================== */
/*  Заметки                                                            */
/* ================================================================== */

function renderNotesList() {
  const query = els.search.value.trim().toLowerCase();
  const sorted = state.notes.slice().sort((a, b) => b.updated - a.updated);
  const visible = query ? sorted.filter((note) => note.title.toLowerCase().includes(query)) : sorted;

  els.notesList.innerHTML = '';

  if (!visible.length) {
    const empty = document.createElement('div');
    empty.className = 'notes-empty';
    empty.textContent = query
      ? 'Ничего не найдено'
      : 'Пока нет конспектов.\nНажмите «Новый конспект» или создайте файл в папке конспектов.';
    els.notesList.appendChild(empty);
    return;
  }

  visible.forEach((note) => {
    const row = document.createElement('div');
    row.className = 'note-row';

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'note-item' + (note.id === state.currentId ? ' active' : '');
    button.innerHTML = '<span class="note-name"></span><span class="note-meta"></span>';
    button.querySelector('.note-name').textContent = note.title;
    button.querySelector('.note-meta').textContent = formatDate(note.updated);
    button.addEventListener('click', () => openNote(note.id));

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'note-del';
    remove.title = 'Удалить конспект';
    remove.textContent = '×';
    remove.addEventListener('click', (event) => {
      event.stopPropagation();
      deleteNote(note.id);
    });

    row.append(button, remove);
    els.notesList.appendChild(row);
  });
}

async function openNote(id) {
  const seq = ++openSeq;

  if (state.currentId === id && !state.dirty) {
    els.editor.focus();
    return;
  }

  /* дожидаемся незавершённых операций с текущим файлом */
  if (state.titleTimer) {
    clearTimeout(state.titleTimer);
    state.titleTimer = null;
    renamePromise = commitTitle();
  }
  await renamePromise;
  if (seq !== openSeq) return;

  if (state.currentId && state.dirty) await saveNow();
  if (seq !== openSeq) return;

  let note;
  try {
    note = await bridge.readNote(id);
  } catch (err) {
    if (seq === openSeq) toast('Не удалось открыть конспект: ' + err.message, true);
    return;
  }
  if (seq !== openSeq) return;

  state.currentId = note.id;
  state.dirty = false;
  els.editor.value = note.content;
  els.title.value = note.title;
  updateWindowTitle();

  els.editor.scrollTop = 0;
  els.preview.scrollTop = 0;
  renderPreview();
  renderNotesList();
  updateStats();
  setStatus('Сохранено');
  els.editor.focus();
}

async function newNote() {
  if (state.currentId && state.dirty) await saveNow();

  try {
    const note = await bridge.createNote('Новый конспект');
    state.notes.unshift(note);
    renderNotesList();
    await openNote(note.id);
    els.title.focus();
    els.title.select();
  } catch (err) {
    toast('Не удалось создать конспект: ' + err.message, true);
  }
}

async function deleteNote(id) {
  const note = state.notes.find((item) => item.id === id);
  const title = note ? note.title : id;

  if (!window.confirm('Удалить «' + title + '»?\n\nФайл будет перемещён в корзину.')) return;

  try {
    await bridge.deleteNote(id);
  } catch (err) {
    toast('Не удалось удалить: ' + err.message, true);
    return;
  }

  state.notes = state.notes.filter((item) => item.id !== id);

  if (state.currentId === id) {
    state.currentId = null;
    state.dirty = false;
    els.editor.value = '';
    els.title.value = '';
    els.preview.innerHTML = '';
    activePlots.forEach((plot) => { try { plot.destroy(); } catch { /* ignore */ } });
    activePlots = [];

    if (state.notes.length) {
      await openNote(state.notes[0].id);
    } else {
      const fresh = await bridge.createNote('Новый конспект');
      state.notes.push(fresh);
      await openNote(fresh.id);
    }
  }

  renderNotesList();
  toast('Конспект удалён');
}

/* ================================================================== */
/*  Сохранение                                                         */
/* ================================================================== */

function scheduleSave() {
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(() => {
    state.saveTimer = null;
    saveNow();
  }, 700);
}

function saveNow() {
  clearTimeout(state.saveTimer);
  state.saveTimer = null;

  if (!state.currentId) return Promise.resolve();

  const id = state.currentId;
  const content = els.editor.value;

  setStatus('Сохранение…', 'pending');

  saveChain = saveChain
    .then(async () => {
      if (id !== state.currentId) return;

      await bridge.saveNote(id, content);

      const item = state.notes.find((note) => note.id === id);
      if (item) {
        item.updated = Date.now();
        const meta = els.notesList.querySelector('.note-item.active .note-meta');
        if (meta) meta.textContent = formatDate(item.updated);
      }

      if (state.currentId === id) {
        if (els.editor.value === content) {
          state.dirty = false;
          setStatus('Сохранено');
        } else {
          scheduleSave();
        }
      }
    })
    .catch((err) => {
      setStatus('Ошибка сохранения', 'error');
      toast('Не удалось сохранить: ' + (err.message || err), true);
    });

  return saveChain;
}

async function commitTitle() {
  const oldId = state.currentId;
  if (!oldId) return;

  const raw = els.title.value.trim();
  if (!raw) {
    const current = state.notes.find((note) => note.id === oldId);
    if (current && document.activeElement !== els.title) els.title.value = current.title;
    return;
  }

  await saveNow();

  let result;
  try {
    result = await bridge.renameNote(oldId, raw);
  } catch (err) {
    toast('Не удалось переименовать: ' + err.message, true);
    return;
  }

  const item = state.notes.find((note) => note.id === oldId);
  if (item) {
    item.id = result.id;
    item.title = result.title;
    item.updated = Date.now();
  }

  if (state.currentId === oldId) {
    state.currentId = result.id;
    if (document.activeElement !== els.title) els.title.value = result.title;
    updateWindowTitle();
  }

  renderNotesList();
}

/* ================================================================== */
/*  Вставка формул и блоков                                            */
/* ================================================================== */

function insertSnippet(template) {
  /* в режиме чтения редактор скрыт — переключаемся, чтобы вставка была видна */
  if (state.mode === 'read') applyMode('split');

  const textarea = els.editor;
  textarea.focus();

  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const selected = textarea.value.slice(start, end);

  let text = String(template).split('$sel$').join(selected);
  let caret = text.length;

  const marker = '$caret$';
  const markerIndex = text.indexOf(marker);
  if (markerIndex >= 0) {
    text = text.slice(0, markerIndex) + text.slice(markerIndex + marker.length);
    caret = markerIndex;
  }

  let inserted = false;
  try {
    inserted = document.execCommand('insertText', false, text);
  } catch {
    inserted = false;
  }

  if (!inserted) {
    textarea.setRangeText(text, start, end, 'end');
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  }

  const caretPos = start + caret;
  textarea.setSelectionRange(caretPos, caretPos);
  updateStats();
}

function decodeAttr(value) {
  return String(value || '').replace(/\\n/g, '\n');
}

function getSelectionText() {
  return els.editor.value.slice(els.editor.selectionStart, els.editor.selectionEnd);
}

function isInsideMath() {
  const before = els.editor.value.slice(0, els.editor.selectionStart);

  const displayMarks = (before.match(/\$\$/g) || []).length;
  if (displayMarks % 2 === 1) return true;

  const singleMarks = (before.replace(/\$\$/g, '').match(/(?<!\\)\$/g) || []).length;
  if (singleMarks % 2 === 1) return true;

  const openParen = (before.match(/\\\(/g) || []).length;
  const closeParen = (before.match(/\\\)/g) || []).length;
  return openParen > closeParen;
}

function wrapSelection(before, after, options) {
  const opts = options || {};
  const selected = getSelectionText();
  const inside = isInsideMath();
  const block = !!opts.block;

  let prefix = '';
  let suffix = '';

  if (opts.math && !inside) {
    if (block) {
      prefix = '\n$$\n';
      suffix = '\n$$\n';
    } else {
      prefix = '$';
      suffix = '$';
    }
  }

  let template;
  if (selected) {
    template = prefix + before + '$sel$' + after + suffix;
    if (block && !inside) template += '\n';
  } else {
    template = prefix + before + '$caret$' + after + suffix;
  }

  insertSnippet(template);
}

function insertInlineMath() {
  if (isInsideMath()) {
    toast('Курсор уже внутри формулы');
    return;
  }

  const selected = getSelectionText();
  if (selected) insertSnippet('$' + selected + '$$caret$');
  else insertSnippet('$$caret$');
}

function insertBlockMath() {
  const selected = getSelectionText();
  if (selected) insertSnippet('\n$$\n' + selected + '\n$$\n$caret$');
  else insertSnippet('\n$$\n$caret$\n$$\n');
}

function insertPlot() {
  const textarea = els.editor;
  textarea.focus();

  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const template = '```plot\nf(x) = sin(x)\nx: -2*pi..2*pi\ntitle: График\n```\n';

  let inserted = false;
  try {
    inserted = document.execCommand('insertText', false, template);
  } catch {
    inserted = false;
  }

  if (!inserted) {
    textarea.setRangeText(template, start, end, 'end');
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  }

  const exprIndex = start + template.indexOf('sin(x)');
  textarea.setSelectionRange(exprIndex, exprIndex + 'sin(x)'.length);
  updateStats();
  toast('Введите выражение — график построится сам');
}

function insertTable() {
  insertSnippet('| $caret$ |  |\n| --- | --- |\n|  |  |\n');
}

function insertPaletteItem(tex, display) {
  const inside = isInsideMath();

  if (display) {
    if (inside) insertSnippet(tex);
    else insertSnippet('\n$$\n' + tex + '\n$$\n');
  } else {
    if (inside) insertSnippet(tex);
    else insertSnippet('$' + tex + '$');
  }
}

/* ================================================================== */
/*  Палитра формул                                                     */
/* ================================================================== */

const PALETTE = {
  basic: [
    { tex: 'x^{2}', label: 'степень' },
    { tex: 'x_{i}', label: 'индекс' },
    { tex: 'x_{i}^{2}', label: 'индекс и степень' },
    { tex: '\\frac{a}{b}', label: 'дробь' },
    { tex: '\\sqrt{x}', label: 'корень' },
    { tex: '\\sqrt[n]{x}', label: 'корень n-й' },
    { tex: '|x|', label: 'модуль' },
    { tex: '\\binom{n}{k}', label: 'сочетания' },
    { tex: '\\overline{x}', label: 'черта' },
    { tex: '\\hat{x}', label: 'шляпка' },
    { tex: '\\vec{v}', label: 'вектор' },
    { tex: '\\underline{x}', label: 'подчёркивание' },
    { tex: '\\text{текст}', label: 'текст' },
    { tex: '\\boxed{E}', label: 'рамка' }
  ],
  ops: [
    { tex: '\\sum_{i=1}^{n} a_i', label: 'сумма' },
    { tex: '\\prod_{i=1}^{n} a_i', label: 'произведение' },
    { tex: '\\int_{a}^{b} f(x)\\,dx', label: 'интеграл' },
    { tex: '\\lim_{x \\to 0} f(x)', label: 'предел' },
    { tex: '\\frac{d}{dx}', label: 'производная' },
    { tex: '\\frac{\\partial f}{\\partial x}', label: 'частная' },
    { tex: '\\nabla f', label: 'градиент' },
    { tex: '\\Delta x', label: 'приращение' },
    { tex: '\\varepsilon', label: 'эпсилон' },
    { tex: '\\approx', label: '≈' },
    { tex: '\\sim', label: '~' },
    { tex: '\\propto', label: '∝' },
    { tex: '\\pm', label: '±' },
    { tex: '\\times', label: '×' },
    { tex: '\\cdot', label: '·' },
    { tex: '\\div', label: '÷' },
    { tex: '\\le', label: '≤' },
    { tex: '\\ge', label: '≥' },
    { tex: '\\ne', label: '≠' },
    { tex: '\\infty', label: '∞' },
    { tex: '\\to', label: '→' },
    { tex: '\\Rightarrow', label: '⇒' },
    { tex: '\\forall', label: '∀' },
    { tex: '\\exists', label: '∃' },
    { tex: '\\partial', label: '∂' }
  ],
  greek: [
    { tex: '\\alpha', label: 'альфа' },
    { tex: '\\beta', label: 'бета' },
    { tex: '\\gamma', label: 'гамма' },
    { tex: '\\delta', label: 'дельта' },
    { tex: '\\varepsilon', label: 'эпсилон' },
    { tex: '\\zeta', label: 'дзета' },
    { tex: '\\eta', label: 'эта' },
    { tex: '\\theta', label: 'тета' },
    { tex: '\\lambda', label: 'лямбда' },
    { tex: '\\mu', label: 'мю' },
    { tex: '\\nu', label: 'ню' },
    { tex: '\\xi', label: 'кси' },
    { tex: '\\pi', label: 'пи' },
    { tex: '\\rho', label: 'ро' },
    { tex: '\\sigma', label: 'сигма' },
    { tex: '\\tau', label: 'тау' },
    { tex: '\\varphi', label: 'фи' },
    { tex: '\\chi', label: 'хи' },
    { tex: '\\psi', label: 'пси' },
    { tex: '\\omega', label: 'омега' },
    { tex: '\\Gamma', label: 'Гамма' },
    { tex: '\\Delta', label: 'Дельта' },
    { tex: '\\Theta', label: 'Тета' },
    { tex: '\\Lambda', label: 'Лямбда' },
    { tex: '\\Sigma', label: 'Сигма' },
    { tex: '\\Phi', label: 'Фи' },
    { tex: '\\Psi', label: 'Пси' },
    { tex: '\\Omega', label: 'Омега' }
  ],
  struct: [
    {
      tex: '\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}',
      label: 'матрица 2×2',
      display: true
    },
    {
      tex: '\\begin{pmatrix} a_{11} & a_{12} & a_{13} \\\\ a_{21} & a_{22} & a_{23} \\\\ a_{31} & a_{32} & a_{33} \\end{pmatrix}',
      label: 'матрица 3×3',
      display: true
    },
    {
      tex: '\\begin{vmatrix} a & b \\\\ c & d \\end{vmatrix}',
      label: 'определитель',
      display: true
    },
    {
      tex: '\\begin{cases} x + y = 1 \\\\ x - y = 0 \\end{cases}',
      label: 'система',
      display: true
    },
    {
      tex: '\\begin{aligned} a &= b + c \\\\ d &= e - f \\end{aligned}',
      label: 'выравнивание',
      display: true
    },
    {
      tex: '\\begin{array}{c|c} a & b \\\\ \\hline c & d \\end{array}',
      label: 'таблица',
      display: true
    },
    {
      tex: '\\left[\\begin{array}{ccc|c} 1 & 2 & 3 & 4 \\\\ 5 & 6 & 7 & 8 \\end{array}\\right]',
      label: 'расширенная',
      display: true
    },
    {
      tex: '\\underbrace{x + y}_{\\text{сумма}}',
      label: 'под скобкой'
    },
    {
      tex: '\\overbrace{x + y}^{\\text{сумма}}',
      label: 'над скобкой'
    },
    {
      tex: '\\left\\{ x \\,\\middle|\\, x > 0 \\right\\}',
      label: 'множество',
      display: true
    },
    {
      tex: '\\begin{matrix} a & b \\\\ c & d \\end{matrix}',
      label: 'без скобок',
      display: true
    },
    {
      tex: '\\displaystyle\\lim_{n \\to \\infty}',
      label: 'предел n→∞'
    }
  ],
  methods: [
    {
      name: 'Метод Ньютона',
      tex: 'x_{k+1} = x_k - \\frac{f(x_k)}{f\'(x_k)}'
    },
    {
      name: 'Метод бисекции',
      tex: 'c = \\frac{a + b}{2}, \\qquad f(a)\\,f(b) < 0'
    },
    {
      name: 'Простая итерация',
      tex: 'x^{(k+1)} = \\varphi\\bigl(x^{(k)}\\bigr)'
    },
    {
      name: 'Метод секущих',
      tex: 'x_{k+1} = x_k - f(x_k)\\,\\frac{x_k - x_{k-1}}{f(x_k) - f(x_{k-1})}'
    },
    {
      name: 'Интерполяция Лагранжа',
      tex: 'L_n(x) = \\sum_{i=0}^{n} f(x_i)\\,\\ell_i(x),\\quad \\ell_i(x) = \\prod_{j \\ne i} \\frac{x - x_j}{x_i - x_j}'
    },
    {
      name: 'Интерполяция Ньютона',
      tex: 'P_n(x) = f(x_0) + \\sum_{k=1}^{n} f(x_0,\\dots,x_k) \\prod_{j=0}^{k-1} (x - x_j)'
    },
    {
      name: 'МНК (линейная)',
      tex: 'S(a,b) = \\sum_{i=1}^{n} \\bigl(y_i - a - b x_i\\bigr)^2 \\to \\min'
    },
    {
      name: 'Метод Эйлера',
      tex: 'y_{i+1} = y_i + h\\,f(x_i, y_i)'
    },
    {
      name: 'Рунге — Кутта 4',
      tex: 'y_{i+1} = y_i + \\frac{h}{6}\\bigl(k_1 + 2k_2 + 2k_3 + k_4\\bigr)'
    },
    {
      name: 'Формула Симпсона',
      tex: '\\int_a^b f(x)\\,dx \\approx \\frac{h}{3}\\Bigl(f_0 + 4\\!\\!\\sum_{i\\ \\text{odd}}\\!\\! f_i + 2\\!\\!\\sum_{i\\ \\text{even}}\\!\\! f_i + f_n\\Bigr)'
    },
    {
      name: 'Оценка погрешности',
      tex: '|x_n - x^*| \\le \\frac{q^n}{1 - q}\\,|x_1 - x_0|'
    },
    {
      name: 'Метод Гаусса — Зейделя',
      tex: 'x_i^{(k+1)} = \\frac{1}{a_{ii}}\\Bigl(b_i - \\sum_{j<i} a_{ij} x_j^{(k+1)} - \\sum_{j>i} a_{ij} x_j^{(k)}\\Bigr)'
    },
    {
      name: 'LU-разложение',
      tex: 'A = LU, \\qquad L\\,U\\,x = b'
    },
    {
      name: 'Полином',
      tex: 'P_n(x) = a_0 + a_1 x + \\dots + a_n x^n'
    },
    {
      name: 'Разделённая разность',
      tex: 'f(x_i,\\dots,x_{i+k}) = \\frac{f(x_{i+1},\\dots,x_{i+k}) - f(x_i,\\dots,x_{i+k-1})}{x_{i+k} - x_i}'
    }
  ]
};

function buildPalette(tab) {
  const items = PALETTE[tab] || PALETTE.basic;

  els.paletteTabs.querySelectorAll('button').forEach((button) => {
    button.classList.toggle('active', button.dataset.tab === tab);
  });

  els.paletteBody.innerHTML = '';

  if (tab === 'methods') {
    const list = document.createElement('div');
    list.className = 'palette-list';

    items.forEach((item) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'method-btn';
      button.dataset.tex = item.tex;
      button.dataset.display = '1';
      button.title = 'Вставить формулу';

      const name = document.createElement('span');
      name.className = 'method-name';
      name.textContent = item.name;

      const formula = document.createElement('span');
      formula.className = 'method-formula';
      formula.innerHTML = renderTex(item.tex, false);

      button.append(name, formula);
      list.appendChild(button);
    });

    els.paletteBody.appendChild(list);

    const hint = document.createElement('div');
    hint.className = 'palette-hint';
    hint.textContent = 'Клик вставляет формулу отдельным блоком. Дальше можно править её как обычный текст.';
    els.paletteBody.appendChild(hint);
    return;
  }

  const grid = document.createElement('div');
  grid.className = 'palette-grid';

  items.forEach((item) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'palette-btn';
    button.dataset.tex = item.tex;
    if (item.display) button.dataset.display = '1';
    button.title = item.tex;

    const preview = document.createElement('span');
    preview.innerHTML = renderTex(item.tex, false);

    button.appendChild(preview);

    if (item.label) {
      const label = document.createElement('span');
      label.className = 'pb-label';
      label.textContent = item.label;
      button.appendChild(label);
    }

    grid.appendChild(button);
  });

  els.paletteBody.appendChild(grid);

  const hint = document.createElement('div');
  hint.className = 'palette-hint';
  hint.textContent = 'Если курсор вне формулы — знаки $ добавятся сами. Внутри формулы вставляется только LaTeX.';
  els.paletteBody.appendChild(hint);
}

function openPalette() {
  closeBuilder();
  closeCalc();
  els.palette.classList.remove('hidden');
  els.palette.setAttribute('aria-hidden', 'false');
}

function closePalette() {
  els.palette.classList.add('hidden');
  els.palette.setAttribute('aria-hidden', 'true');
}

function togglePalette() {
  if (els.palette.classList.contains('hidden')) openPalette();
  else closePalette();
}

/* ================================================================== */
/*  Шпаргалка                                                          */
/* ================================================================== */

function openHelp() {
  closePalette();
  closeBuilder();
  closeCalc();
  closeFind();
  els.helpModal.classList.remove('hidden');
  els.helpModal.setAttribute('aria-hidden', 'false');
}

function closeHelp() {
  els.helpModal.classList.add('hidden');
  els.helpModal.setAttribute('aria-hidden', 'true');
}

function renderHelpMath() {
  els.helpModal.querySelectorAll('.mini-math[data-tex]').forEach((node) => {
    try {
      katex.render(node.dataset.tex, node, {
        throwOnError: false,
        displayMode: false,
        strict: 'ignore',
        trust: false,
        macros: MATH_MACROS
      });
    } catch {
      node.textContent = node.dataset.tex;
    }
  });
}

/* ================================================================== */
/*  Поиск по тексту                                                    */
/* ================================================================== */

function scrollEditorTo(pos) {
  const lineHeight = Number.parseFloat(getComputedStyle(els.editor).lineHeight) || 25;
  const before = els.editor.value.slice(0, pos);
  const line = (before.match(/\n/g) || []).length;
  els.editor.scrollTop = Math.max(
    0,
    Math.min(els.editor.scrollHeight, line * lineHeight - els.editor.clientHeight / 2)
  );
}

function showFindSelection(scroll) {
  const total = findState.matches.length;
  if (!total || findState.index < 0) {
    els.findCount.textContent = '0/0';
    return;
  }

  const start = findState.matches[findState.index];
  els.editor.setSelectionRange(start, start + findState.query.length);
  els.findCount.textContent = (findState.index + 1) + '/' + total;
  if (scroll) scrollEditorTo(start);
}

function refreshFind(resetIndex) {
  findState.query = els.findInput.value;
  const hay = els.editor.value;
  const needle = findState.query.toLowerCase();
  const matches = [];

  if (needle) {
    const hayLower = hay.toLowerCase();
    let i = hayLower.indexOf(needle);
    while (i !== -1) {
      matches.push(i);
      i = hayLower.indexOf(needle, i + needle.length);
    }
  }

  findState.matches = matches;

  if (!matches.length) {
    findState.index = -1;
  } else if (resetIndex) {
    const caret = els.editor.selectionStart;
    const idx = matches.findIndex((m) => m >= caret);
    findState.index = idx === -1 ? 0 : idx;
  } else if (findState.index < 0) {
    findState.index = 0;
  } else {
    findState.index = Math.min(findState.index, matches.length - 1);
  }

  showFindSelection(true);
}

function findStep(direction) {
  const total = findState.matches.length;
  if (!total) return;
  findState.index = (findState.index + direction + total) % total;
  showFindSelection(true);
}

function openFind() {
  closePalette();
  closeBuilder();
  closeCalc();

  if (state.mode === 'read') applyMode('split');

  const start = els.editor.selectionStart;
  const end = els.editor.selectionEnd;
  if (end > start && end - start < 120 && !els.editor.value.slice(start, end).includes('\n')) {
    els.findInput.value = els.editor.value.slice(start, end);
  }

  els.findbar.classList.remove('hidden');
  els.findInput.focus();
  els.findInput.select();
  refreshFind(true);
}

function closeFind() {
  els.findbar.classList.add('hidden');
  findState.matches = [];
  findState.index = -1;
  els.findCount.textContent = '0/0';
  els.editor.focus();
}

/* ================================================================== */
/*  Конструктор записи                                                 */
/* ================================================================== */

const FORMULA_TEMPLATES = [
  {
    id: 'frac', name: 'Дробь', hint: 'числитель / знаменатель',
    tex: '\\frac{{{a}}}{{{b}}}',
    fields: [{ key: 'a', label: 'Числитель', value: 'a' }, { key: 'b', label: 'Знаменатель', value: 'b' }]
  },
  {
    id: 'pow', name: 'Степень', hint: 'x во второй степени',
    tex: '{{{base}}}^{{{exp}}}',
    fields: [{ key: 'base', label: 'Основание', value: 'x' }, { key: 'exp', label: 'Показатель', value: '2' }]
  },
  {
    id: 'sub', name: 'Индекс', hint: 'x с нижним индексом',
    tex: '{{{base}}}_{{{index}}}',
    fields: [{ key: 'base', label: 'Основание', value: 'x' }, { key: 'index', label: 'Индекс', value: 'i' }]
  },
  {
    id: 'subsup', name: 'Индекс и степень', hint: 'x_i во второй степени',
    tex: '{{{base}}}_{{{index}}}^{{{pow}}}',
    fields: [
      { key: 'base', label: 'Основание', value: 'x' },
      { key: 'index', label: 'Индекс', value: 'i' },
      { key: 'pow', label: 'Степень', value: '2' }
    ]
  },
  {
    id: 'sqrt', name: 'Корень', hint: '√x',
    tex: '\\sqrt{{{expr}}}',
    fields: [{ key: 'expr', label: 'Под корнем', value: 'x' }]
  },
  {
    id: 'root', name: 'Корень n-й степени', hint: 'ⁿ√x',
    tex: '\\sqrt[{{{n}}}]{{{expr}}}',
    fields: [{ key: 'n', label: 'Степень корня', value: 'n' }, { key: 'expr', label: 'Под корнем', value: 'x' }]
  },
  {
    id: 'abs', name: 'Модуль', hint: '|x|',
    tex: '\\left|{{{expr}}}\\right|',
    fields: [{ key: 'expr', label: 'Выражение', value: 'x' }]
  },
  {
    id: 'paren', name: 'Скобки', hint: 'крупные ( )',
    tex: '\\left({{{expr}}}\\right)',
    fields: [{ key: 'expr', label: 'Выражение', value: 'x + 1' }]
  },
  {
    id: 'sum', name: 'Сумма', hint: '∑ от … до …',
    tex: '\\sum_{{{from}}}^{{{to}}} {{{term}}}',
    fields: [
      { key: 'from', label: 'Нижний предел', value: 'i=1' },
      { key: 'to', label: 'Верхний предел', value: 'n' },
      { key: 'term', label: 'Слагаемое', value: 'a_i' }
    ]
  },
  {
    id: 'prod', name: 'Произведение', hint: '∏ от … до …',
    tex: '\\prod_{{{from}}}^{{{to}}} {{{term}}}',
    fields: [
      { key: 'from', label: 'Нижний предел', value: 'i=1' },
      { key: 'to', label: 'Верхний предел', value: 'n' },
      { key: 'term', label: 'Множитель', value: 'a_i' }
    ]
  },
  {
    id: 'integral', name: 'Интеграл', hint: '∫ от a до b',
    tex: '\\int_{{{from}}}^{{{to}}} {{{func}}}\\,d{{{var}}}',
    fields: [
      { key: 'from', label: 'Нижний предел', value: 'a' },
      { key: 'to', label: 'Верхний предел', value: 'b' },
      { key: 'func', label: 'Функция', value: 'f(x)' },
      { key: 'var', label: 'Переменная', value: 'x' }
    ]
  },
  {
    id: 'limit', name: 'Предел', hint: 'lim при x → 0',
    tex: '\\lim_{{{var}} \\to {{{to}}}} {{{expr}}}',
    fields: [
      { key: 'var', label: 'Переменная', value: 'x' },
      { key: 'to', label: 'Стремится к', value: '0' },
      { key: 'expr', label: 'Выражение', value: 'f(x)' }
    ]
  },
  {
    id: 'derivative', name: 'Производная', hint: 'df/dx',
    tex: '\\frac{d{{{func}}}}{d{{{var}}}}',
    fields: [{ key: 'func', label: 'Функция', value: 'f' }, { key: 'var', label: 'Переменная', value: 'x' }]
  },
  {
    id: 'partial', name: 'Частная производная', hint: '∂f/∂x',
    tex: '\\frac{\\partial {{{func}}}}{\\partial {{{var}}}}',
    fields: [{ key: 'func', label: 'Функция', value: 'f' }, { key: 'var', label: 'Переменная', value: 'x' }]
  },
  {
    id: 'binom', name: 'Сочетания', hint: 'C из n по k',
    tex: '\\binom{{{n}}}{{{k}}}',
    fields: [{ key: 'n', label: 'Всего n', value: 'n' }, { key: 'k', label: 'Выбрать k', value: 'k' }]
  },
  {
    id: 'matrix2', name: 'Матрица 2×2', hint: 'круглые скобки',
    tex: '\\begin{pmatrix} {{{a}}} & {{{b}}} \\\\ {{{c}}} & {{{d}}} \\end{pmatrix}',
    fields: [
      { key: 'a', label: 'a11', value: 'a' }, { key: 'b', label: 'a12', value: 'b' },
      { key: 'c', label: 'a21', value: 'c' }, { key: 'd', label: 'a22', value: 'd' }
    ]
  },
  {
    id: 'det2', name: 'Определитель 2×2', hint: 'вертикальные черты',
    tex: '\\begin{vmatrix} {{{a}}} & {{{b}}} \\\\ {{{c}}} & {{{d}}} \\end{vmatrix}',
    fields: [
      { key: 'a', label: 'a11', value: 'a' }, { key: 'b', label: 'a12', value: 'b' },
      { key: 'c', label: 'a21', value: 'c' }, { key: 'd', label: 'a22', value: 'd' }
    ]
  },
  {
    id: 'cases', name: 'Система уравнений', hint: 'фигурная скобка',
    tex: '\\begin{cases} {{{eq1}}} \\\\ {{{eq2}}} \\end{cases}',
    fields: [
      { key: 'eq1', label: 'Первое уравнение', value: 'x + y = 1', wide: true },
      { key: 'eq2', label: 'Второе уравнение', value: 'x - y = 0', wide: true }
    ]
  },
  {
    id: 'aligned', name: 'Выравнивание', hint: 'две строки по знаку =',
    tex: '\\begin{aligned} {{{l1}}} &= {{{r1}}} \\\\ {{{l2}}} &= {{{r2}}} \\end{aligned}',
    fields: [
      { key: 'l1', label: 'Левая часть 1', value: 'a' }, { key: 'r1', label: 'Правая часть 1', value: 'b + c' },
      { key: 'l2', label: 'Левая часть 2', value: 'd' }, { key: 'r2', label: 'Правая часть 2', value: 'e - f' }
    ]
  },
  {
    id: 'set', name: 'Множество', hint: '{ x | условие }',
    tex: '\\left\\{ {{{x}}} \\mid {{{cond}}} \\right\\}',
    fields: [{ key: 'x', label: 'Элемент', value: 'x' }, { key: 'cond', label: 'Условие', value: 'x > 0' }]
  },
  {
    id: 'text', name: 'Текст в формуле', hint: 'обычные слова',
    tex: '\\text{{{text}}}',
    fields: [{ key: 'text', label: 'Текст', value: 'текст' }]
  }
];

const PLOT_TEMPLATE = {
  id: 'plot',
  name: 'График',
  hint: 'функции, диапазон, точки',
  fields: [
    { key: 'functions', label: 'Функции (по одной в строке)', value: 'f(x) = sin(x)', wide: true, multiline: true },
    { key: 'x1', label: 'x от', value: '-2*pi' },
    { key: 'x2', label: 'x до', value: '2*pi' },
    { key: 'y1', label: 'y от (необязательно)', value: '', placeholder: 'авто' },
    { key: 'y2', label: 'y до (необязательно)', value: '', placeholder: 'авто' },
    { key: 'points', label: 'Точки', value: '', wide: true, placeholder: '(1, 2); (2, 4)' },
    { key: 'title', label: 'Подпись под графиком', value: 'График', wide: true }
  ]
};

const TABLE_TEMPLATE = {
  id: 'table',
  name: 'Таблица',
  hint: 'строки и столбцы',
  fields: [
    { key: 'cols', label: 'Столбцов', value: '3', type: 'number' },
    { key: 'rows', label: 'Строк с данными', value: '3', type: 'number' }
  ]
};

let builderGroup = 'formula';
let builderId = 'frac';
let builderPlot = null;
let builderTimer = null;
const builderMemory = new Map();

function builderTemplates() {
  if (builderGroup === 'plot') return [PLOT_TEMPLATE];
  if (builderGroup === 'table') return [TABLE_TEMPLATE];
  return FORMULA_TEMPLATES;
}

function builderCurrent() {
  const list = builderTemplates();
  return list.find((item) => item.id === builderId) || list[0];
}

function builderValue(template, field) {
  const store = builderMemory.get(builderGroup + ':' + template.id);
  if (store && Object.prototype.hasOwnProperty.call(store, field.key)) return store[field.key];
  return field.value;
}

function setBuilderValue(template, key, value) {
  const storeKey = builderGroup + ':' + template.id;
  const store = builderMemory.get(storeKey) || {};
  store[key] = value;
  builderMemory.set(storeKey, store);
}

function buildFormulaTex(template) {
  return template.tex.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    const field = template.fields.find((item) => item.key === key);
    return field ? String(builderValue(template, field)) : '';
  });
}

function buildPlotSource(template) {
  const get = (key) => String(builderValue(template, template.fields.find((f) => f.key === key))).trim();
  const lines = [];

  const funcs = get('functions');
  if (funcs) lines.push(funcs);

  lines.push('x: ' + (get('x1') || '-10') + '..' + (get('x2') || '10'));

  const y1 = get('y1');
  const y2 = get('y2');
  if (y1 && y2) lines.push('y: ' + y1 + '..' + y2);

  const points = get('points');
  if (points) lines.push('points: ' + points);

  const title = get('title');
  if (title) lines.push('title: ' + title);

  return lines.join('\n');
}

function buildTableMarkdown(template) {
  const readNumber = (key, fallback, max) => {
    const value = Number.parseInt(String(builderValue(template, template.fields.find((f) => f.key === key))), 10);
    if (!Number.isFinite(value)) return fallback;
    return Math.max(1, Math.min(max, value));
  };

  const cols = readNumber('cols', 3, 12);
  const rows = readNumber('rows', 3, 50);
  const head = [];
  const empty = [];

  for (let i = 0; i < cols; i += 1) {
    head.push('Столбец ' + (i + 1));
    empty.push(' ');
  }

  const lines = [
    '| ' + head.join(' | ') + ' |',
    '| ' + head.map(() => '---').join(' | ') + ' |'
  ];

  for (let r = 0; r < rows; r += 1) {
    lines.push('| ' + empty.join(' | ') + ' |');
  }

  return lines.join('\n');
}

function destroyBuilderPlot() {
  if (builderPlot) {
    try { builderPlot.destroy(); } catch { /* ignore */ }
    builderPlot = null;
  }
}

function updateBuilderPreview() {
  const template = builderCurrent();
  destroyBuilderPlot();
  els.builderPreview.className = 'builder-preview';
  els.builderPreview.innerHTML = '';

  if (builderGroup === 'formula') {
    els.builderPreview.innerHTML = renderTex(buildFormulaTex(template), true);
    return;
  }

  if (builderGroup === 'plot') {
    const source = buildPlotSource(template);
    const holder = document.createElement('div');
    holder.className = 'plot-canvas builder-plot';
    els.builderPreview.appendChild(holder);

    try {
      builderPlot = window.PlotLib.create(holder, source);
    } catch (err) {
      holder.remove();
      const error = document.createElement('div');
      error.className = 'builder-error';
      error.textContent = 'Ошибка в графике: ' + (err.message || err);
      els.builderPreview.appendChild(error);
    }
    return;
  }

  const table = buildTableMarkdown(template);
  els.builderPreview.classList.add('markdown-body');
  els.builderPreview.innerHTML = renderMarkdown(table);
}

function renderBuilderFields() {
  const template = builderCurrent();
  els.builderFields.innerHTML = '';

  template.fields.forEach((field) => {
    const wrap = document.createElement('div');
    wrap.className = 'builder-field' + (field.wide ? ' wide' : '');

    const label = document.createElement('label');
    label.textContent = field.label;

    let input;
    if (field.multiline) {
      input = document.createElement('textarea');
      input.rows = 3;
    } else {
      input = document.createElement('input');
      input.type = field.type === 'number' ? 'number' : 'text';
      if (field.type === 'number') {
        input.min = '1';
        input.max = '50';
      }
    }

    input.value = builderValue(template, field);
    if (field.placeholder) input.placeholder = field.placeholder;
    input.spellcheck = false;

    input.addEventListener('input', () => {
      setBuilderValue(template, field.key, input.value);
      clearTimeout(builderTimer);
      builderTimer = setTimeout(updateBuilderPreview, 120);
    });

    wrap.append(label, input);
    els.builderFields.appendChild(wrap);
  });
}

function renderBuilder() {
  els.builderTabs.querySelectorAll('button').forEach((button) => {
    button.classList.toggle('active', button.dataset.group === builderGroup);
  });

  const templates = builderTemplates();
  if (!templates.some((item) => item.id === builderId)) builderId = templates[0].id;

  els.builderList.innerHTML = '';
  templates.forEach((template) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'builder-item' + (template.id === builderId ? ' active' : '');
    button.innerHTML = '<span class="bi-name"></span><span class="bi-hint"></span>';
    button.querySelector('.bi-name').textContent = template.name;
    button.querySelector('.bi-hint').textContent = template.hint || '';
    button.addEventListener('click', () => {
      builderId = template.id;
      renderBuilder();
    });
    els.builderList.appendChild(button);
  });

  els.builderInsert.textContent = builderGroup === 'formula' ? 'Вставить в строку' : 'Вставить';
  els.builderInsertBlock.classList.toggle('hidden', builderGroup !== 'formula');

  renderBuilderFields();
  updateBuilderPreview();
}

function openBuilder() {
  closePalette();
  closeCalc();
  closeFind();
  els.builderModal.classList.remove('hidden');
  els.builderModal.setAttribute('aria-hidden', 'false');
  renderBuilder();
  const firstField = els.builderFields.querySelector('input, textarea');
  if (firstField) firstField.focus();
}

function closeBuilder() {
  clearTimeout(builderTimer);
  destroyBuilderPlot();
  els.builderModal.classList.add('hidden');
  els.builderModal.setAttribute('aria-hidden', 'true');
}

function builderInsert(block) {
  const template = builderCurrent();

  if (builderGroup === 'formula') {
    const tex = buildFormulaTex(template);
    closeBuilder();
    insertPaletteItem(tex, block);
    toast('Формула вставлена');
    return;
  }

  if (builderGroup === 'plot') {
    const source = buildPlotSource(template);
    try {
      window.PlotLib.validate(source);
    } catch (err) {
      toast('Ошибка в графике: ' + (err.message || err), true);
      return;
    }
    closeBuilder();
    insertSnippet('\n```plot\n' + source + '\n```\n');
    toast('График вставлен');
    return;
  }

  const table = buildTableMarkdown(template);
  closeBuilder();
  insertSnippet('\n' + table + '\n');
  toast('Таблица вставлена');
}

/* ================================================================== */
/*  Калькулятор                                                        */
/* ================================================================== */

let calcHistory = loadCalcHistory();

function loadCalcHistory() {
  try {
    const saved = JSON.parse(localStorage.getItem('nn.calc.history') || '[]');
    if (!Array.isArray(saved)) return [];
    return saved
      .filter((item) => item && typeof item.expr === 'string' && typeof item.result === 'string')
      .slice(0, 30);
  } catch {
    return [];
  }
}

function saveCalcHistory() {
  try {
    localStorage.setItem('nn.calc.history', JSON.stringify(calcHistory.slice(0, 30)));
  } catch {
    /* не критично */
  }
}

function formatCalcValue(value) {
  if (!Number.isFinite(value)) return value > 0 ? '∞' : '−∞';
  if (value === 0) return '0';

  const rounded = Number(value.toPrecision(14));
  const abs = Math.abs(rounded);

  if (abs >= 1e15 || abs < 1e-9) {
    return rounded.toExponential(8).replace(/\.?0+e/, 'e');
  }

  return String(rounded);
}

function calcEvaluate(showError) {
  const expr = els.calcExpr.value.trim();
  if (!expr) {
    els.calcResult.classList.remove('error');
    els.calcResult.textContent = '= 0';
    return null;
  }

  try {
    const value = window.PlotLib.evaluate(expr);
    if (typeof value !== 'number' || Number.isNaN(value)) {
      throw new Error('Результат не является числом');
    }
    const result = formatCalcValue(value);
    els.calcResult.classList.remove('error');
    els.calcResult.textContent = '= ' + result;
    return { expr, result };
  } catch (err) {
    if (showError) {
      els.calcResult.classList.add('error');
      els.calcResult.textContent = err.message || String(err);
    } else {
      els.calcResult.classList.remove('error');
      els.calcResult.textContent = '= …';
    }
    return null;
  }
}

function renderCalcHistory() {
  els.calcHistory.innerHTML = '';

  if (!calcHistory.length) {
    const empty = document.createElement('div');
    empty.className = 'calc-history-empty';
    empty.textContent = 'Здесь появятся вычисления.';
    els.calcHistory.appendChild(empty);
    return;
  }

  calcHistory.forEach((item) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'calc-history-item';
    button.innerHTML = '<span class="h-expr"></span><span class="h-res"></span>';
    button.querySelector('.h-expr').textContent = item.expr;
    button.querySelector('.h-res').textContent = '= ' + item.result;
    button.title = 'Вставить это выражение в калькулятор';
    button.addEventListener('click', () => {
      els.calcExpr.value = item.expr;
      calcEvaluate(false);
      els.calcExpr.focus();
    });
    els.calcHistory.appendChild(button);
  });
}

function pushCalcHistory(expr, result) {
  if (calcHistory[0] && calcHistory[0].expr === expr && calcHistory[0].result === result) return;
  calcHistory.unshift({ expr, result });
  calcHistory = calcHistory.slice(0, 30);
  saveCalcHistory();
  renderCalcHistory();
}

function calcCommit() {
  const result = calcEvaluate(true);
  if (result) pushCalcHistory(result.expr, result.result);
}

function calcInsertText(text) {
  const input = els.calcExpr;
  const start = input.selectionStart == null ? input.value.length : input.selectionStart;
  const end = input.selectionEnd == null ? start : input.selectionEnd;
  input.setRangeText(text, start, end, 'end');
  input.focus();
  calcEvaluate(false);
}

function calcBackspace() {
  const input = els.calcExpr;
  const start = input.selectionStart;
  const end = input.selectionEnd;

  if (start !== end) {
    input.setRangeText('', start, end, 'end');
  } else if (start > 0) {
    input.setRangeText('', start - 1, start, 'end');
  }

  input.focus();
  calcEvaluate(false);
}

function calcInsertToNote(kind) {
  const result = calcEvaluate(true);
  if (!result) return;

  if (!state.currentId) {
    toast('Сначала откройте конспект', true);
    return;
  }

  closeCalc();
  insertSnippet(kind === 'expr' ? result.expr : result.result);
  toast(kind === 'expr' ? 'Выражение вставлено' : 'Ответ вставлен');
}

function openCalc() {
  closePalette();
  closeBuilder();
  els.calc.classList.remove('hidden');
  els.calc.setAttribute('aria-hidden', 'false');
  renderCalcHistory();
  els.calcExpr.focus();
  els.calcExpr.select();
  calcEvaluate(false);
}

function closeCalc() {
  els.calc.classList.add('hidden');
  els.calc.setAttribute('aria-hidden', 'true');
}

function toggleCalc() {
  if (els.calc.classList.contains('hidden')) openCalc();
  else closeCalc();
}

/* ================================================================== */
/*  Экспорт PDF                                                        */
/* ================================================================== */

async function exportPDF() {
  await saveNow();

  const hadMode = state.mode;
  const wasLight = document.body.classList.contains('light');

  /* Для PDF всегда используем светлую тему: иначе графики печатаются
     тёмными прямоугольниками на белой странице. */
  if (!wasLight) document.body.classList.add('light');

  /* Важно: заменяем класс, а не добавляем — иначе в режиме «только редактор»
     просмотр остаётся скрытым и графики в PDF выходят пустыми. */
  els.app.className = 'mode-read';

  renderPreview();
  await new Promise((resolve) => setTimeout(resolve, 350));

  try {
    const filePath = await bridge.exportPDF(els.title.value.trim() || 'Конспект');
    if (filePath) toast('PDF сохранён: ' + filePath);
  } catch (err) {
    toast('Не удалось создать PDF: ' + (err.message || err), true);
  } finally {
    els.app.className = 'mode-' + hadMode;
    if (!wasLight) document.body.classList.remove('light');
    requestAnimationFrame(() => {
      activePlots.forEach((plot) => {
        try { plot.redraw(); } catch { /* ignore */ }
      });
    });
  }
}

/* ================================================================== */
/*  События интерфейса                                                 */
/* ================================================================== */

function bindUI() {
  document.getElementById('btn-new').addEventListener('click', newNote);
  document.getElementById('btn-open-folder').addEventListener('click', () => bridge.openNotesDir());
  document.getElementById('btn-theme').addEventListener('click', toggleTheme);
  document.getElementById('btn-export').addEventListener('click', exportPDF);
  document.getElementById('btn-help').addEventListener('click', openHelp);
  document.getElementById('btn-palette').addEventListener('click', togglePalette);
  document.getElementById('palette-close').addEventListener('click', closePalette);
  document.getElementById('btn-insert-math').addEventListener('click', insertBlockMath);
  document.getElementById('btn-insert-plot').addEventListener('click', insertPlot);
  document.getElementById('btn-builder').addEventListener('click', openBuilder);
  document.getElementById('btn-calc').addEventListener('click', toggleCalc);

  document.querySelectorAll('.view-switch button').forEach((button) => {
    button.addEventListener('click', () => applyMode(button.dataset.mode));
  });

  /* палитра */
  els.paletteTabs.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-tab]');
    if (button) buildPalette(button.dataset.tab);
  });

  els.paletteBody.addEventListener('click', (event) => {
    const button = event.target.closest('[data-tex]');
    if (!button) return;
    insertPaletteItem(button.dataset.tex, button.dataset.display === '1');
  });

  /* поиск по тексту */
  els.findInput.addEventListener('input', () => refreshFind(true));
  els.findInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      findStep(event.shiftKey ? -1 : 1);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      closeFind();
    }
  });
  document.getElementById('find-next').addEventListener('click', () => findStep(1));
  document.getElementById('find-prev').addEventListener('click', () => findStep(-1));
  document.getElementById('find-close').addEventListener('click', closeFind);

  /* конструктор */
  els.builderTabs.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-group]');
    if (!button) return;
    builderGroup = button.dataset.group;
    builderId = builderTemplates()[0].id;
    renderBuilder();
  });
  els.builderInsert.addEventListener('click', () => builderInsert(false));
  els.builderInsertBlock.addEventListener('click', () => builderInsert(true));
  els.builderModal.querySelectorAll('[data-close="builder"]').forEach((node) => {
    node.addEventListener('click', closeBuilder);
  });

  /* калькулятор */
  document.getElementById('calc-close').addEventListener('click', closeCalc);
  document.getElementById('calc-insert-result').addEventListener('click', () => calcInsertToNote('result'));
  document.getElementById('calc-insert-expr').addEventListener('click', () => calcInsertToNote('expr'));
  document.getElementById('calc-clear-history').addEventListener('click', () => {
    calcHistory = [];
    saveCalcHistory();
    renderCalcHistory();
  });

  els.calcExpr.addEventListener('input', () => calcEvaluate(false));
  els.calcExpr.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      calcCommit();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      closeCalc();
    }
  });

  els.calcKeys.addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    const action = button.dataset.action;

    if (action === 'clear') {
      els.calcExpr.value = '';
      calcEvaluate(false);
      els.calcExpr.focus();
      return;
    }
    if (action === 'back') {
      calcBackspace();
      return;
    }
    if (action === 'equals') {
      calcCommit();
      return;
    }
    if (button.dataset.insert) calcInsertText(button.dataset.insert);
  });

  els.calcFuncs.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-insert]');
    if (button) calcInsertText(button.dataset.insert);
  });

  /* закрытие палитры по клику вне */
  document.addEventListener('pointerdown', (event) => {
    if (els.palette.classList.contains('hidden')) return;
    if (event.target.closest('#palette') || event.target.closest('#btn-palette')) return;
    closePalette();
  });

  /* шпаргалка */
  els.helpModal.querySelectorAll('[data-close="help"]').forEach((node) => {
    node.addEventListener('click', closeHelp);
  });

  /* поиск */
  els.search.addEventListener('input', renderNotesList);

  /* редактор */
  els.editor.addEventListener('input', () => {
    state.dirty = true;
    setStatus('Правка…', 'pending');
    updateStats();

    clearTimeout(state.renderTimer);
    state.renderTimer = setTimeout(renderPreview, 260);
    scheduleSave();
  });

  els.editor.addEventListener('keyup', updateStats);
  els.editor.addEventListener('click', updateStats);
  els.editor.addEventListener('select', updateStats);

  els.editor.addEventListener('keydown', (event) => {
    const ctrl = event.ctrlKey || event.metaKey;

    if (event.key === 'Tab') {
      event.preventDefault();
      insertSnippet('  ');
      return;
    }

    if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.altKey) {
      const pos = els.editor.selectionStart;
      const lineStart = els.editor.value.lastIndexOf('\n', pos - 1) + 1;
      const line = els.editor.value.slice(lineStart, pos);
      const match = /^(\s*)([-*+]|\d+\.)\s+(.*)$/.exec(line);

      if (match) {
        event.preventDefault();

        if (!match[3].trim()) {
          els.editor.setRangeText('', lineStart, pos, 'start');
          els.editor.dispatchEvent(new Event('input', { bubbles: true }));
          els.editor.setSelectionRange(lineStart, lineStart);
          return;
        }

        let marker = match[2];
        if (/^\d+\.$/.test(marker)) marker = parseInt(marker, 10) + 1 + '.';
        insertSnippet('\n' + match[1] + marker + ' ');
      }
      return;
    }

    if (ctrl && !event.shiftKey && event.key.toLowerCase() === 'b') {
      event.preventDefault();
      wrapSelection('**', '**');
      return;
    }

    if (ctrl && !event.shiftKey && event.key.toLowerCase() === 'i') {
      event.preventDefault();
      wrapSelection('*', '*');
    }
  });

  /* заголовок */
  els.title.addEventListener('input', () => {
    updateWindowTitle();
    clearTimeout(state.titleTimer);
    state.titleTimer = setTimeout(() => {
      state.titleTimer = null;
      renamePromise = commitTitle();
    }, 900);
  });

  els.title.addEventListener('blur', () => {
    if (state.titleTimer) {
      clearTimeout(state.titleTimer);
      state.titleTimer = null;
      renamePromise = commitTitle();
    } else {
      const current = state.notes.find((note) => note.id === state.currentId);
      if (current) els.title.value = current.title;
    }
  });

  els.title.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      els.title.blur();
      els.editor.focus();
    }
  });

  /* кнопки-обёртки */
  document.querySelectorAll('#toolbar [data-before]').forEach((button) => {
    button.addEventListener('click', () => {
      const before = decodeAttr(button.dataset.before);
      const after = decodeAttr(button.dataset.after);
      wrapSelection(before, after, {
        math: button.dataset.math === '1',
        block: button.dataset.block === '1'
      });
    });
  });

  /* разделитель */
  let dragging = false;
  els.divider.addEventListener('pointerdown', (event) => {
    dragging = true;
    els.divider.classList.add('dragging');
    els.divider.setPointerCapture(event.pointerId);
  });

  window.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    const rect = els.work.getBoundingClientRect();
    let ratio = (event.clientX - rect.left) / rect.width;
    ratio = Math.max(0.2, Math.min(0.8, ratio));
    state.split = ratio;
    els.work.style.setProperty('--split', (ratio * 100).toFixed(2) + '%');
    localStorage.setItem('nn.split', ratio.toFixed(4));
  });

  const stopDrag = (event) => {
    if (!dragging) return;
    dragging = false;
    els.divider.classList.remove('dragging');
    if (event && event.pointerId !== undefined && els.divider.hasPointerCapture(event.pointerId)) {
      els.divider.releasePointerCapture(event.pointerId);
    }
    activePlots.forEach((plot) => {
      try { plot.redraw(); } catch { /* ignore */ }
    });
  };

  window.addEventListener('pointerup', stopDrag);
  window.addEventListener('pointercancel', stopDrag);

  /* горячие клавиши, не занятые меню */
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    closePalette();
    closeHelp();
    if (!els.calc.classList.contains('hidden')) closeCalc();
    if (!els.builderModal.classList.contains('hidden')) closeBuilder();
    if (!els.findbar.classList.contains('hidden')) closeFind();
  });

  /* при расфокусе окна сохраняем */
  window.addEventListener('blur', () => {
    if (state.dirty) saveNow();
  });

  /* меню Electron */
  bridge.onMenu((action) => {
    switch (action) {
      case 'new-note': newNote(); break;
      case 'save': saveNow().then(() => toast('Сохранено')); break;
      case 'export-pdf': exportPDF(); break;
      case 'insert-inline-math': insertInlineMath(); break;
      case 'insert-block-math': insertBlockMath(); break;
      case 'insert-plot': insertPlot(); break;
      case 'insert-table': insertTable(); break;
      case 'toggle-palette': togglePalette(); break;
      case 'mode-edit': applyMode('edit'); break;
      case 'mode-split': applyMode('split'); break;
      case 'mode-read': applyMode('read'); break;
      case 'toggle-theme': toggleTheme(); break;
      case 'help': openHelp(); break;
      case 'find': openFind(); break;
      case 'builder': openBuilder(); break;
      case 'calculator': toggleCalc(); break;
      default: break;
    }
  });
}

/* ================================================================== */
/*  Запуск                                                             */
/* ================================================================== */

async function init() {
  applyTheme();

  els.work.style.setProperty('--split', (clampSplit(state.split) * 100).toFixed(2) + '%');

  applyMode(state.mode);
  buildPalette('basic');
  bindUI();
  renderHelpMath();

  try {
    const dir = await bridge.notesDir();
    document.getElementById('btn-open-folder').title = 'Открыть папку: ' + dir;
  } catch {
    /* ignore */
  }

  try {
    state.notes = await bridge.listNotes();
  } catch (err) {
    els.preview.innerHTML =
      '<div class="plot-error"><strong>Не удалось прочитать папку конспектов</strong>' +
      escapeHtml(err.message || String(err)) + '</div>';
    return;
  }

  renderNotesList();

  if (state.notes.length) {
    await openNote(state.notes[0].id);
  } else {
    const note = await bridge.createNote('Первый конспект');
    state.notes.push(note);
    await openNote(note.id);
  }
}

init().catch((err) => {
  console.error(err);
  toast('Ошибка запуска: ' + (err.message || err), true);
});
