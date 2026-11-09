/* ==================================================================
   Мини-построитель графиков: разбор выражений + интерактивный canvas.
   Без внешних зависимостей.
   ================================================================== */
(function () {
  'use strict';

  const CONSTS = {
    pi: Math.PI,
    e: Math.E,
    tau: Math.PI * 2,
    inf: Infinity
  };

  const FUNCS = {
    sin: (x) => Math.sin(x),
    cos: (x) => Math.cos(x),
    tan: (x) => Math.tan(x),
    cot: (x) => 1 / Math.tan(x),
    sec: (x) => 1 / Math.cos(x),
    csc: (x) => 1 / Math.sin(x),
    asin: (x) => Math.asin(x),
    acos: (x) => Math.acos(x),
    atan: (x) => Math.atan(x),
    atan2: (y, x) => Math.atan2(y, x),
    sinh: (x) => Math.sinh(x),
    cosh: (x) => Math.cosh(x),
    tanh: (x) => Math.tanh(x),
    exp: (x) => Math.exp(x),
    ln: (x) => Math.log(x),
    log: (x) => Math.log10(x),
    lg: (x) => Math.log10(x),
    log2: (x) => Math.log2(x),
    log10: (x) => Math.log10(x),
    sqrt: (x) => Math.sqrt(x),
    cbrt: (x) => Math.cbrt(x),
    abs: (x) => Math.abs(x),
    sign: (x) => Math.sign(x),
    floor: (x) => Math.floor(x),
    ceil: (x) => Math.ceil(x),
    round: (x) => Math.round(x),
    trunc: (x) => Math.trunc(x),
    pow: (x, p) => Math.pow(x, p),
    mod: (x, p) => x % p,
    min: (...a) => Math.min(...a),
    max: (...a) => Math.max(...a),
    hypot: (...a) => Math.hypot(...a)
  };

  const OPS = { '+': 1, '-': 1, '*': 2, '/': 2, '%': 2, '^': 4 };

  function fail(message) {
    throw new Error(message);
  }

  /* -------------------------- токенизация -------------------------- */

  function tokenize(src) {
    const tokens = [];
    const s = String(src);
    let i = 0;

    while (i < s.length) {
      const ch = s[i];

      if (/\s/.test(ch)) { i++; continue; }

      if (/[0-9.]/.test(ch)) {
        const m = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(s.slice(i));
        if (!m) fail('Некорректное число в выражении');
        tokens.push({ type: 'number', value: parseFloat(m[0]) });
        i += m[0].length;
        continue;
      }

      if (/[A-Za-z_]/.test(ch) || ch === 'π' || ch === 'τ' || ch === 'ε') {
        if (ch === 'π') { tokens.push({ type: 'ident', value: 'pi' }); i++; continue; }
        if (ch === 'τ') { tokens.push({ type: 'ident', value: 'tau' }); i++; continue; }
        if (ch === 'ε') { tokens.push({ type: 'ident', value: 'e' }); i++; continue; }
        const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(s.slice(i));
        tokens.push({ type: 'ident', value: m[0].toLowerCase() });
        i += m[0].length;
        continue;
      }

      if (ch === '(') { tokens.push({ type: 'lparen' }); i++; continue; }
      if (ch === ')') { tokens.push({ type: 'rparen' }); i++; continue; }
      if (ch === ',') { tokens.push({ type: 'comma' }); i++; continue; }

      if (ch === '×' || ch === '·') { tokens.push({ type: 'op', value: '*' }); i++; continue; }
      if (ch === '÷') { tokens.push({ type: 'op', value: '/' }); i++; continue; }
      if (ch === '−' || ch === '–') { tokens.push({ type: 'op', value: '-' }); i++; continue; }

      if (Object.prototype.hasOwnProperty.call(OPS, ch)) {
        tokens.push({ type: 'op', value: ch });
        i++;
        continue;
      }

      fail('Неизвестный символ «' + ch + '»');
    }

    return tokens;
  }

  function isValueEnd(t) {
    return t && (t.type === 'number' || t.type === 'ident' || t.type === 'rparen');
  }

  function isValueStart(t) {
    return t && (t.type === 'number' || t.type === 'ident' || t.type === 'lparen');
  }

  function withImplicitMultiplication(tokens) {
    const out = [];
    for (let i = 0; i < tokens.length; i++) {
      const prev = tokens[i - 1];
      const cur = tokens[i];
      if (i > 0 && isValueEnd(prev) && isValueStart(cur)) {
        const isCall = prev.type === 'ident' && cur.type === 'lparen';
        if (!isCall) out.push({ type: 'op', value: '*' });
      }
      out.push(cur);
    }
    return out;
  }

  /* ---------------------------- парсер ----------------------------- */

  function compileExpression(src) {
    if (!String(src).trim()) fail('Пустое выражение');

    const tokens = withImplicitMultiplication(tokenize(src));
    let pos = 0;

    const peek = (n) => tokens[pos + (n || 0)];
    const next = () => tokens[pos++];

    function parseExpression(minPrec) {
      let left = parseUnary();

      while (true) {
        const t = peek();
        if (!t || t.type !== 'op') break;
        const prec = OPS[t.value];
        if (prec === undefined || prec < minPrec) break;
        next();
        const right = parseExpression(t.value === '^' ? prec : prec + 1);
        left = { type: 'binary', op: t.value, left, right };
      }

      return left;
    }

    function parseUnary() {
      const t = peek();
      if (t && t.type === 'op' && (t.value === '+' || t.value === '-')) {
        next();
        return { type: 'unary', op: t.value, arg: parseExpression(3) };
      }
      return parsePrimary();
    }

    function parsePrimary() {
      const t = next();
      if (!t) fail('Неожиданный конец выражения');

      if (t.type === 'number') return { type: 'number', value: t.value };

      if (t.type === 'ident') {
        const name = t.value;
        const nxt = peek();

        if (nxt && nxt.type === 'lparen') {
          next();
          const args = [];
          if (peek() && peek().type === 'rparen') {
            next();
          } else {
            args.push(parseExpression(0));
            while (peek() && peek().type === 'comma') {
              next();
              args.push(parseExpression(0));
            }
            const r = next();
            if (!r || r.type !== 'rparen') fail('Ожидалась закрывающая скобка');
          }
          if (!FUNCS[name]) fail('Неизвестная функция «' + name + '»');
          return { type: 'call', name, args };
        }

        return { type: 'var', name };
      }

      if (t.type === 'lparen') {
        const expr = parseExpression(0);
        const r = next();
        if (!r || r.type !== 'rparen') fail('Ожидалась закрывающая скобка');
        return expr;
      }

      fail('Неожиданный символ «' + (t.value || t.type) + '»');
      return null;
    }

    const ast = parseExpression(0);
    if (pos < tokens.length) {
      fail('Лишнее выражение после «' + (tokens[pos].value || tokens[pos].type) + '»');
    }

    return function evaluate(scope) {
      return evalNode(ast, scope || {});
    };
  }

  function evalNode(node, scope) {
    switch (node.type) {
      case 'number':
        return node.value;

      case 'var': {
        if (Object.prototype.hasOwnProperty.call(scope, node.name)) return scope[node.name];
        if (Object.prototype.hasOwnProperty.call(CONSTS, node.name)) return CONSTS[node.name];
        fail('Неизвестная переменная «' + node.name + '»');
        return NaN;
      }

      case 'unary': {
        const value = evalNode(node.arg, scope);
        return node.op === '-' ? -value : value;
      }

      case 'binary': {
        const a = evalNode(node.left, scope);
        const b = evalNode(node.right, scope);
        switch (node.op) {
          case '+': return a + b;
          case '-': return a - b;
          case '*': return a * b;
          case '/': return a / b;
          case '%': return a % b;
          case '^': return Math.pow(a, b);
          default: return NaN;
        }
      }

      case 'call': {
        const fn = FUNCS[node.name];
        if (!fn) fail('Неизвестная функция «' + node.name + '»');
        const args = node.args.map((a) => evalNode(a, scope));
        return fn.apply(null, args);
      }

      default:
        return NaN;
    }
  }

  /* --------------------------- конфигурация ------------------------ */

  function evalScalar(src, consts) {
    const f = compileExpression(src);
    return f(consts);
  }

  function parseRange(value, consts, axis) {
    const str = String(value).trim();
    let parts = str.split(/\s*\.\.\s*/);
    if (parts.length !== 2) parts = str.split(/\s*,\s*/);
    if (parts.length !== 2) parts = str.split(/\s+/);
    if (parts.length !== 2) fail('Диапазон ' + axis + ' задаётся как «от..до»');

    const a = evalScalar(parts[0], consts);
    const b = evalScalar(parts[1], consts);
    if (!Number.isFinite(a) || !Number.isFinite(b)) fail('Границы диапазона ' + axis + ' должны быть числами');
    if (a >= b) fail('Для ' + axis + ' левая граница должна быть меньше правой');
    return [a, b];
  }

  function parsePoints(value, consts) {
    const points = [];
    const groups = String(value).split(';').map((s) => s.trim()).filter(Boolean);

    for (const group of groups) {
      const body = group.replace(/^\(/, '').replace(/\)$/, '');
      const parts = body.split(',');
      if (parts.length !== 2) fail('Точки задаются как (x, y); (x, y); …');
      const x = evalScalar(parts[0], consts);
      const y = evalScalar(parts[1], consts);
      if (Number.isFinite(x) && Number.isFinite(y)) points.push({ x, y });
    }

    return points;
  }

  function parsePlotSource(source) {
    const cfg = {
      curves: [],
      points: [],
      xmin: -10,
      xmax: 10,
      ymin: null,
      ymax: null,
      title: '',
      consts: {}
    };

    const lines = String(source == null ? '' : source).replace(/\r/g, '').split('\n');

    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith('#') || line.startsWith('//')) continue;

      let m;

      if ((m = /^points?\s*[:=]\s*(.+)$/i.exec(line))) {
        cfg.points.push(...parsePoints(m[1], cfg.consts));
        continue;
      }

      if ((m = /^title\s*[:=]\s*(.+)$/i.exec(line))) {
        cfg.title = m[1].trim();
        continue;
      }

      if ((m = /^x\s*[:=]\s*(.+)$/i.exec(line)) && !/^x\s*\(/i.test(line)) {
        const r = parseRange(m[1], cfg.consts, 'x');
        cfg.xmin = r[0];
        cfg.xmax = r[1];
        continue;
      }

      if ((m = /^y\s*[:=]\s*(.+)$/i.exec(line)) && !/^y\s*\(/i.test(line)) {
        const value = m[1].trim();
        if (/^auto$/i.test(value)) {
          cfg.ymin = null;
          cfg.ymax = null;
        } else {
          const r = parseRange(value, cfg.consts, 'y');
          cfg.ymin = r[0];
          cfg.ymax = r[1];
        }
        continue;
      }

      if ((m = /^([A-Za-z_]\w*)\s*\(\s*x\s*\)\s*=\s*(.+)$/.exec(line))) {
        cfg.curves.push({
          name: m[1],
          src: m[2],
          f: compileExpression(m[2])
        });
        continue;
      }

      if ((m = /^y\s*=\s*(.+)$/.exec(line))) {
        cfg.curves.push({ name: 'y', src: m[1], f: compileExpression(m[1]) });
        continue;
      }

      if ((m = /^([A-Za-z_]\w*)\s*=\s*(.+)$/.exec(line))) {
        const name = m[1];
        const rhs = m[2];
        if (/\bx\b/.test(rhs)) {
          cfg.curves.push({ name, src: rhs, f: compileExpression(rhs) });
        } else {
          cfg.consts[name] = evalScalar(rhs, cfg.consts);
        }
        continue;
      }

      cfg.curves.push({
        name: shortLabel(line),
        src: line,
        f: compileExpression(line)
      });
    }

    if (cfg.xmin >= cfg.xmax) fail('Левая граница x должна быть меньше правой');

    // Проверяем, что все выражения действительно вычисляются
    for (const c of cfg.curves) {
      evaluateCurve(c, cfg, cfg.xmin + (cfg.xmax - cfg.xmin) * 0.37);
    }

    return cfg;
  }

  function shortLabel(line) {
    const clean = String(line).trim();
    return clean.length > 24 ? clean.slice(0, 23) + '…' : clean;
  }

  function evaluateCurve(curve, cfg, x) {
    const scope = cfg._scope || (cfg._scope = Object.assign({}, cfg.consts));
    scope.x = x;
    return curve.f(scope);
  }

  function sampleRange(cfg, count) {
    const values = [];
    const scope = Object.assign({}, cfg.consts);

    for (const curve of cfg.curves) {
      for (let i = 0; i <= count; i++) {
        const x = cfg.xmin + ((cfg.xmax - cfg.xmin) * i) / count;
        scope.x = x;
        let y;
        try {
          y = curve.f(scope);
        } catch {
          continue;
        }
        if (Number.isFinite(y)) values.push(y);
      }
    }

    for (const p of cfg.points) {
      if (Number.isFinite(p.y)) values.push(p.y);
    }

    return values;
  }

  function computeAutoY(cfg) {
    const values = sampleRange(cfg, 600).sort((a, b) => a - b);

    if (!values.length) return [-1, 1];

    let lo = values[0];
    let hi = values[values.length - 1];

    if (values.length >= 20) {
      lo = values[Math.floor(values.length * 0.01)];
      hi = values[Math.ceil(values.length * 0.99) - 1];
    }

    if (!Number.isFinite(lo) || !Number.isFinite(hi) || !(hi > lo)) {
      const center = Number.isFinite(lo) ? lo : 0;
      return [center - 1, center + 1];
    }

    const pad = (hi - lo) * 0.08;
    return [lo - pad, hi + pad];
  }

  /* ---------------------------- отрисовка -------------------------- */

  function niceTicks(min, max, count) {
    if (!(max > min)) return { ticks: [], step: 1 };

    const span = max - min;
    const raw = span / Math.max(1, count);
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const norm = raw / mag;

    let mult = 1;
    if (norm > 1) mult = 2;
    if (norm > 2) mult = 5;
    if (norm > 5) mult = 10;

    const step = mult * mag;
    const first = Math.ceil(min / step) * step;
    const ticks = [];

    for (let i = 0; i < 400; i++) {
      const v = first + i * step;
      if (v > max + step * 1e-9) break;
      ticks.push(Math.abs(v) < step * 1e-9 ? 0 : v);
    }

    return { ticks, step };
  }

  function formatTick(value, step) {
    if (Math.abs(value) < 1e-12) return '0';

    const abs = Math.abs(value);
    if (abs >= 1e6 || abs < 1e-4) {
      return value.toExponential(1).replace('e+', 'e');
    }

    let decimals = Math.max(0, -Math.floor(Math.log10(step)));
    decimals = Math.min(decimals, 6);

    let out = value.toFixed(decimals);
    if (out.indexOf('.') !== -1) out = out.replace(/0+$/, '').replace(/\.$/, '');
    return out;
  }

  function formatCoord(value) {
    if (!Number.isFinite(value)) return '—';
    const abs = Math.abs(value);
    if (abs !== 0 && (abs >= 1e5 || abs < 1e-4)) return value.toExponential(2);
    if (abs >= 1000) return value.toFixed(1);
    return String(Math.round(value * 10000) / 10000);
  }

  function paletteForTheme() {
    const light = document.body.classList.contains('light');
    return light
      ? ['#3c63e0', '#e0662f', '#0f9d82', '#8a4bd6', '#b57b00', '#d6426a', '#0b7ea8']
      : ['#7c9cff', '#ff9f6e', '#59e3c5', '#c99cff', '#ffd166', '#ff7b9c', '#8be9fd'];
  }

  function cssColors() {
    const cs = getComputedStyle(document.body);
    const read = (name, fallback) => {
      const v = cs.getPropertyValue(name).trim();
      return v || fallback;
    };
    return {
      bg: read('--plot-bg', '#0d121a'),
      grid: read('--plot-grid', 'rgba(255,255,255,.08)'),
      axis: read('--plot-axis', 'rgba(255,255,255,.3)'),
      text: read('--plot-text', '#98a3b8'),
      curves: paletteForTheme()
    };
  }

  function create(container, source) {
    const cfg = parsePlotSource(source);

    container.innerHTML = '';

    const canvas = document.createElement('canvas');
    canvas.setAttribute('aria-label', 'График');
    container.appendChild(canvas);

    const tools = document.createElement('div');
    tools.className = 'plot-tools';
    const resetBtn = document.createElement('button');
    resetBtn.type = 'button';
    resetBtn.textContent = 'СБРОС';
    resetBtn.title = 'Вернуть исходный масштаб';
    const pngBtn = document.createElement('button');
    pngBtn.type = 'button';
    pngBtn.textContent = 'PNG';
    pngBtn.title = 'Сохранить график как PNG';
    tools.append(resetBtn, pngBtn);
    container.appendChild(tools);

    const readout = document.createElement('div');
    readout.className = 'plot-readout';
    container.appendChild(readout);

    const ctx = canvas.getContext('2d');
    const [autoMin, autoMax] = cfg.ymin == null || cfg.ymax == null ? computeAutoY(cfg) : [cfg.ymin, cfg.ymax];

    const base = {
      xmin: cfg.xmin,
      xmax: cfg.xmax,
      ymin: cfg.ymin == null ? autoMin : cfg.ymin,
      ymax: cfg.ymax == null ? autoMax : cfg.ymax
    };

    if (!(base.ymax > base.ymin)) {
      /* если задан только ymin (или границы перепутаны) — расширяем диапазон
         симметрично, чтобы график не оказался вывернутым или нулевым */
      const center = (base.ymin + base.ymax) / 2;
      const span = Math.max(1, Math.abs(base.ymax - base.ymin), Math.abs(center) * 0.2);
      base.ymin = center - span;
      base.ymax = center + span;
    }

    const view = Object.assign({}, base);
    let colors = cssColors();
    let layout = null;
    let mouse = null;
    let drag = null;
    let frame = 0;

    const caption = container.parentElement
      ? container.parentElement.querySelector('figcaption')
      : null;

    if (caption) {
      if (cfg.title) {
        caption.textContent = cfg.title;
        caption.style.display = '';
      } else {
        caption.textContent = '';
        caption.style.display = 'none';
      }
    }

    function measure() {
      const width = container.clientWidth;
      const height = container.clientHeight;
      if (!width || !height) return null;

      const pad = { l: 58, r: 18, t: 16, b: 40 };
      return {
        width,
        height,
        pad,
        pw: width - pad.l - pad.r,
        ph: height - pad.t - pad.b
      };
    }

    function draw() {
      frame = 0;
      const L = layout || measure();
      if (!L || L.pw < 10 || L.ph < 10) return;

      const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
      const pixelWidth = Math.round(L.width * dpr);
      const pixelHeight = Math.round(L.height * dpr);

      if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
        canvas.width = pixelWidth;
        canvas.height = pixelHeight;
      }

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, L.width, L.height);
      ctx.fillStyle = colors.bg;
      ctx.fillRect(0, 0, L.width, L.height);

      const { pad, pw, ph } = L;
      const v = view;

      const X = (x) => pad.l + ((x - v.xmin) / (v.xmax - v.xmin)) * pw;
      const Y = (y) => pad.t + ((v.ymax - y) / (v.ymax - v.ymin)) * ph;

      const xAxis = niceTicks(v.xmin, v.xmax, Math.max(4, Math.floor(pw / 92)));
      const yAxis = niceTicks(v.ymin, v.ymax, Math.max(3, Math.floor(ph / 56)));

      /* сетка */
      ctx.lineWidth = 1;
      ctx.strokeStyle = colors.grid;
      ctx.beginPath();
      for (const t of xAxis.ticks) {
        const px = Math.round(X(t)) + 0.5;
        ctx.moveTo(px, pad.t);
        ctx.lineTo(px, pad.t + ph);
      }
      for (const t of yAxis.ticks) {
        const py = Math.round(Y(t)) + 0.5;
        ctx.moveTo(pad.l, py);
        ctx.lineTo(pad.l + pw, py);
      }
      ctx.stroke();

      /* оси */
      ctx.strokeStyle = colors.axis;
      ctx.lineWidth = 1.15;
      ctx.beginPath();
      if (v.ymin < 0 && v.ymax > 0) {
        const py = Math.round(Y(0)) + 0.5;
        ctx.moveTo(pad.l, py);
        ctx.lineTo(pad.l + pw, py);
      }
      if (v.xmin < 0 && v.xmax > 0) {
        const px = Math.round(X(0)) + 0.5;
        ctx.moveTo(px, pad.t);
        ctx.lineTo(px, pad.t + ph);
      }
      ctx.stroke();

      /* подписи осей */
      ctx.fillStyle = colors.text;
      ctx.font = '11px "Segoe UI", system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      for (const t of xAxis.ticks) {
        const px = X(t);
        if (px < pad.l - 2 || px > pad.l + pw + 2) continue;
        ctx.fillText(formatTick(t, xAxis.step), px, pad.t + ph + 7);
      }

      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      for (const t of yAxis.ticks) {
        const py = Y(t);
        if (py < pad.t - 2 || py > pad.t + ph + 2) continue;
        ctx.fillText(formatTick(t, yAxis.step), pad.l - 9, py);
      }

      /* кривые */
      ctx.save();
      ctx.beginPath();
      ctx.rect(pad.l, pad.t, pw, ph);
      ctx.clip();

      const span = v.ymax - v.ymin;
      const samples = Math.max(320, Math.min(4200, Math.floor(pw * 2)));

      cfg.curves.forEach((curve, index) => {
        const color = colors.curves[index % colors.curves.length];
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';

        ctx.beginPath();
        let started = false;
        let prevY = null;
        const scope = Object.assign({}, cfg.consts);

        for (let i = 0; i <= samples; i++) {
          const x = v.xmin + ((v.xmax - v.xmin) * i) / samples;
          scope.x = x;

          let y;
          try {
            y = curve.f(scope);
          } catch {
            started = false;
            prevY = null;
            continue;
          }

          if (!Number.isFinite(y)) {
            started = false;
            prevY = null;
            continue;
          }

          if (Math.abs(y) > 1e12) {
            started = false;
            prevY = null;
            continue;
          }

          if (y < v.ymin - span * 4 || y > v.ymax + span * 4) {
            started = false;
            prevY = y;
            continue;
          }

          if (prevY !== null && Math.abs(y - prevY) > span * 2) {
            started = false;
          }

          const px = X(x);
          const py = Math.max(-1e5, Math.min(1e5, Y(y)));

          if (!started) {
            ctx.moveTo(px, py);
            started = true;
          } else {
            ctx.lineTo(px, py);
          }

          prevY = y;
        }

        ctx.stroke();
      });

      /* точки */
      cfg.points.forEach((point) => {
        const px = X(point.x);
        const py = Y(point.y);
        if (!Number.isFinite(px) || !Number.isFinite(py)) return;

        ctx.beginPath();
        ctx.arc(px, py, 3.6, 0, Math.PI * 2);
        ctx.fillStyle = colors.curves[cfg.curves.length % colors.curves.length];
        ctx.fill();
        ctx.lineWidth = 1.4;
        ctx.strokeStyle = colors.bg;
        ctx.stroke();
      });

      ctx.restore();

      /* легенда */
      if (cfg.curves.length || cfg.points.length) {
        const items = cfg.curves.map((curve, i) => ({
          color: colors.curves[i % colors.curves.length],
          label: curve.name,
          point: false
        }));
        if (cfg.points.length) {
          items.push({
            color: colors.curves[cfg.curves.length % colors.curves.length],
            label: 'точки',
            point: true
          });
        }

        ctx.font = '11.5px "Segoe UI", system-ui, sans-serif';
        let widest = 0;
        for (const item of items) widest = Math.max(widest, ctx.measureText(item.label).width);

        const rowH = 18;
        const boxW = widest + 46;
        const boxH = items.length * rowH + 10;
        const bx = pad.l + 10;
        const by = pad.t + 10;

        ctx.fillStyle = colors.bg;
        ctx.globalAlpha = 0.82;
        ctx.beginPath();
        roundRect(ctx, bx, by, boxW, boxH, 7);
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.strokeStyle = colors.grid;
        ctx.lineWidth = 1;
        ctx.stroke();

        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';

        items.forEach((item, i) => {
          const cy = by + 5 + rowH * i + rowH / 2;
          ctx.strokeStyle = item.color;
          ctx.fillStyle = item.color;
          ctx.lineWidth = 2;

          if (item.point) {
            ctx.beginPath();
            ctx.arc(bx + 14, cy, 3.2, 0, Math.PI * 2);
            ctx.fill();
          } else {
            ctx.beginPath();
            ctx.moveTo(bx + 8, cy);
            ctx.lineTo(bx + 26, cy);
            ctx.stroke();
          }

          ctx.fillStyle = colors.text;
          ctx.fillText(item.label, bx + 32, cy + 0.5);
        });
      }

      /* перекрестие */
      if (mouse && !drag) {
        const px = mouse.px;
        const py = mouse.py;
        if (px >= pad.l && px <= pad.l + pw && py >= pad.t && py <= pad.t + ph) {
          ctx.setLineDash([3, 4]);
          ctx.strokeStyle = colors.axis;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(px, pad.t);
          ctx.lineTo(px, pad.t + ph);
          ctx.moveTo(pad.l, py);
          ctx.lineTo(pad.l + pw, py);
          ctx.stroke();
          ctx.setLineDash([]);
        }
      }
    }

    function roundRect(context, x, y, w, h, r) {
      const radius = Math.min(r, w / 2, h / 2);
      context.beginPath();
      context.moveTo(x + radius, y);
      context.arcTo(x + w, y, x + w, y + h, radius);
      context.arcTo(x + w, y + h, x, y + h, radius);
      context.arcTo(x, y + h, x, y, radius);
      context.arcTo(x, y, x + w, y, radius);
      context.closePath();
    }

    function requestDraw() {
      if (frame) return;
      frame = requestAnimationFrame(draw);
    }

    function updateReadout() {
      if (!layout || !mouse) return;
      const { pad, pw, ph } = layout;
      const px = mouse.px;
      const py = mouse.py;

      if (px < pad.l || px > pad.l + pw || py < pad.t || py > pad.t + ph) {
        readout.textContent = '';
        return;
      }

      const x = view.xmin + ((px - pad.l) / pw) * (view.xmax - view.xmin);
      const y = view.ymax - ((py - pad.t) / ph) * (view.ymax - view.ymin);
      readout.textContent = 'x = ' + formatCoord(x) + '   y = ' + formatCoord(y);
    }

    function eventPos(event) {
      const rect = canvas.getBoundingClientRect();
      return {
        px: event.clientX - rect.left,
        py: event.clientY - rect.top
      };
    }

    canvas.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      if (!layout) return;
      canvas.setPointerCapture(event.pointerId);
      const pos = eventPos(event);
      drag = {
        startPx: pos.px,
        startPy: pos.py,
        view: Object.assign({}, view)
      };
      container.classList.add('dragging');
      mouse = null;
      readout.textContent = '';
    });

    canvas.addEventListener('pointermove', (event) => {
      const pos = eventPos(event);

      if (drag && layout) {
        const dx = ((pos.px - drag.startPx) / layout.pw) * (drag.view.xmax - drag.view.xmin);
        const dy = ((pos.py - drag.startPy) / layout.ph) * (drag.view.ymax - drag.view.ymin);

        view.xmin = drag.view.xmin - dx;
        view.xmax = drag.view.xmax - dx;
        view.ymin = drag.view.ymin + dy;
        view.ymax = drag.view.ymax + dy;
        requestDraw();
        return;
      }

      mouse = pos;
      updateReadout();
      requestDraw();
    });

    function endDrag(event) {
      if (!drag) return;
      drag = null;
      container.classList.remove('dragging');
      if (event && event.pointerId !== undefined && canvas.hasPointerCapture(event.pointerId)) {
        canvas.releasePointerCapture(event.pointerId);
      }
      requestDraw();
    }

    canvas.addEventListener('pointerup', endDrag);
    canvas.addEventListener('pointercancel', endDrag);
    canvas.addEventListener('pointerleave', () => {
      if (drag) return;
      mouse = null;
      readout.textContent = '';
      requestDraw();
    });

    canvas.addEventListener(
      'wheel',
      (event) => {
        if (!layout) return;
        event.preventDefault();

        const pos = eventPos(event);
        const { pad, pw, ph } = layout;

        const fx = Math.min(1, Math.max(0, (pos.px - pad.l) / pw));
        const fy = Math.min(1, Math.max(0, (pos.py - pad.t) / ph));

        const worldX = view.xmin + fx * (view.xmax - view.xmin);
        const worldY = view.ymax - fy * (view.ymax - view.ymin);

        const factor = Math.exp(Math.max(-600, Math.min(600, event.deltaY)) * 0.0016);

        const newW = (view.xmax - view.xmin) * factor;
        const newH = (view.ymax - view.ymin) * factor;

        view.xmin = worldX - fx * newW;
        view.xmax = worldX + (1 - fx) * newW;

        if (!event.shiftKey) {
          view.ymin = worldY - (1 - fy) * newH;
          view.ymax = worldY + fy * newH;
        }

        mouse = pos;
        updateReadout();
        requestDraw();
      },
      { passive: false }
    );

    canvas.addEventListener('dblclick', () => {
      view.xmin = base.xmin;
      view.xmax = base.xmax;
      view.ymin = base.ymin;
      view.ymax = base.ymax;
      requestDraw();
    });

    resetBtn.addEventListener('click', () => {
      view.xmin = base.xmin;
      view.xmax = base.xmax;
      view.ymin = base.ymin;
      view.ymax = base.ymax;
      requestDraw();
    });

    pngBtn.addEventListener('click', () => {
      const oldMouse = mouse;
      mouse = null;
      draw();

      canvas.toBlob((blob) => {
        if (!blob) return;
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        const name = (cfg.title || 'график').replace(/[\\/:*?"<>|]+/g, ' ').trim();
        link.download = (name || 'график') + '.png';
        link.href = url;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 4000);
        mouse = oldMouse;
        requestDraw();
      }, 'image/png');
    });

    const resizeObserver = new ResizeObserver(() => {
      layout = measure();
      requestDraw();
    });
    resizeObserver.observe(container);

    layout = measure();

    return {
      redraw() {
        colors = cssColors();
        layout = measure();
        requestDraw();
      },
      destroy() {
        resizeObserver.disconnect();
        container.innerHTML = '';
      }
    };
  }

  function evaluate(source) {
    const f = compileExpression(source);
    return f({});
  }

  function validate(source) {
    parsePlotSource(source);
  }

  window.PlotLib = { create, evaluate, validate };
})();
