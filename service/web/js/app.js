/* Server Status — front-end logic (vanilla, no deps) */
(function () {
  'use strict';

  var S = { servers: [], expanded: {} };

  /* ----------------- theme: light / dark / system ----------------- */
  var THEME_KEY = 'theme';
  var mql = window.matchMedia('(prefers-color-scheme: dark)');

  function effective(t) { return t === 'system' ? (mql.matches ? 'dark' : 'light') : t; }
  function getTheme() { return localStorage.getItem(THEME_KEY) || 'system'; }

  function applyTheme(t) {
    document.documentElement.dataset.theme = effective(t);
    var btns = document.querySelectorAll('[data-theme-choice]');
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle('active', btns[i].dataset.themeChoice === t);
    }
  }
  function setTheme(t) { localStorage.setItem(THEME_KEY, t); applyTheme(t); }

  function initTheme() {
    var btns = document.querySelectorAll('[data-theme-choice]');
    for (var i = 0; i < btns.length; i++) {
      (function (b) { b.addEventListener('click', function () { setTheme(b.dataset.themeChoice); }); })(btns[i]);
    }
    if (mql.addEventListener) {
      mql.addEventListener('change', function () { if (getTheme() === 'system') applyTheme('system'); });
    }
    applyTheme(getTheme());
  }

  /* ----------------- formatting helpers ----------------- */
  function humanBytes(b) {
    b = Number(b) || 0;
    if (b <= 0) return '0';
    var u = ['B', 'K', 'M', 'G', 'T', 'P'], i = 0;
    while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
    return (b >= 100 || i === 0 ? b.toFixed(0) : b.toFixed(1)) + u[i];
  }
  function humanSpeed(b) { var s = humanBytes(b); return s === '0' ? '0' : s + '/s'; }

  function pct(used, total) {
    used = Number(used); total = Number(total);
    if (!total || total <= 0) return 0;
    return Math.max(0, Math.min(100, used / total * 100));
  }

  function flag(loc) {
    if (!loc) return '';
    var m = String(loc).trim().slice(0, 2).toLowerCase();
    if (!/^[a-z]{2}$/.test(m)) return '';
    return String.fromCodePoint(0x1F1E6 + m.charCodeAt(0) - 97, 0x1F1E6 + m.charCodeAt(1) - 97);
  }

  function fmtUptime(v) {
    if (typeof v !== 'number') return v ? String(v) : '-';
    if (v <= 0) return '-';
    var d = Math.floor(v / 86400), h = Math.floor((v % 86400) / 3600);
    if (d > 0) return d + 'd ' + h + 'h';
    var m = Math.floor((v % 3600) / 60);
    return h + 'h ' + m + 'm';
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  /* ----------------- cell builders ----------------- */
  function protocolCell(s, online) {
    var label, cls = '';
    if (!online) { label = 'Offline'; cls = 'off'; }
    else if (s.online4 && s.online6) { label = 'Dual'; cls = 'dual'; }
    else if (s.online4) { label = 'IPv4'; }
    else { label = 'IPv6'; }
    return '<span class="proto"><span class="dot ' + (online ? 'on' : 'off') + '"></span>' +
      '<span class="pill ' + cls + '">' + label + '</span></span>';
  }

  function duo(inVal, outVal, fmt) {
    return '<span class="duo"><span class="in">' + fmt(inVal) + '</span>' +
      '<span class="sep">|</span><span class="out">' + fmt(outVal) + '</span></span>';
  }

  function regionCell(loc) {
    if (!loc) return '<span class="dim">-</span>';
    var f = flag(loc);
    return '<span class="region">' + (f ? '<span class="flag">' + f + '</span>' : '') +
      '<span class="region-code">' + esc(loc) + '</span></span>';
  }

  function gaugeClass(v) { return 'gauge ' + (v >= 90 ? 'bad' : v >= 70 ? 'warn' : ''); }
  function gauge(kind, val) {
    var v = Math.round(val);
    // 新建时宽度 0 + data-w, 由 flushNewBars() 在下一帧设为目标值 → 从 0 增长
    return '<div class="' + gaugeClass(v) + '" data-kind="' + kind + '">' +
      '<div class="g-top"><span class="g-val">' + v + '%</span></div>' +
      '<div class="bar"><i class="bar-fill" style="width:0" data-w="' + v + '%"></i></div></div>';
  }
  // 就地更新一个进度条单元格: 复用已有 <i> 只改宽度 → 触发 CSS width 过渡动画
  function updateGauge(td, kind, val, online) {
    if (!online) {
      if (td.getAttribute('data-g') !== 'off') { td.innerHTML = '<span class="dim">-</span>'; td.setAttribute('data-g', 'off'); }
      return;
    }
    var v = Math.round(val);
    var fill = td.querySelector('.bar-fill');
    if (!fill) { td.innerHTML = gauge(kind, v); td.setAttribute('data-g', 'on'); return; }
    var g = td.querySelector('.gauge');
    g.className = gaugeClass(v);
    g.setAttribute('data-kind', kind);
    td.querySelector('.g-val').textContent = v + '%';
    fill.style.width = v + '%';
  }

  function pingCell(time, loss, online) {
    time = Number(time); loss = Number(loss);
    if (!online || isNaN(time) || time < 0) return '<span class="ping">-</span>';
    var cls = loss >= 50 ? 'bad' : loss > 0 ? 'mid' : 'good';
    return '<span class="ping ' + cls + '">' + time + 'ms</span>';
  }

  /* ----------------- render ----------------- */
  // 索引 9/10/11 = CPU/RAM/DISK 进度条列(就地更新, 不走 innerHTML)
  var GAUGE_COL = { 9: 'cpu', 10: 'ram', 11: 'disk' };

  function computeCells(s) {
    var online = !!(s.online4 || s.online6);
    var memPct = pct(s.memory_used, s.memory_total);
    var hddPct = pct(s.hdd_used, s.hdd_total);
    var mIn = (Number(s.network_in) || 0) - (Number(s.last_network_in) || 0);
    var mOut = (Number(s.network_out) || 0) - (Number(s.last_network_out) || 0);
    var load = (Number(s.load_1) === -1) ? '–' : Math.max(0, Number(s.load_1) || 0).toFixed(2);
    var cpuVal = Math.max(0, Number(s.cpu) || 0);
    return {
      online: online, cpu: cpuVal, mem: memPct, hdd: hddPct,
      cells: [
        protocolCell(s, online),
        duo(mIn, mOut, humanBytes),
        '<span class="name">' + esc(s.name || '-') + '</span>',
        '<span class="type-tag">' + esc(s.type || '-') + '</span>',
        regionCell(s.location),
        '<span class="mono dim">' + esc(fmtUptime(s.uptime)) + '</span>',
        '<span class="mono">' + load + '</span>',
        online ? duo(s.network_rx, s.network_tx, humanSpeed) : '<span class="dim">-</span>',
        duo(s.network_in, s.network_out, humanBytes),
        online ? gauge('cpu', cpuVal) : '<span class="dim">-</span>',
        online ? gauge('ram', memPct) : '<span class="dim">-</span>',
        online ? gauge('disk', hddPct) : '<span class="dim">-</span>',
        pingCell(s.time_10010, s.ping_10010, online),
        pingCell(s.time_189, s.ping_189, online),
        pingCell(s.time_10086, s.ping_10086, online)
      ]
    };
  }

  function row(s) {
    var c = computeCells(s);
    return '<tr class="row' + (c.online ? '' : ' offline') + '" data-name="' + esc(s.name || '') + '"><td>' +
      c.cells.join('</td><td>') + '</td></tr>';
  }

  // 节点集合(名字与顺序)是否与当前 DOM 一致 → 决定整建 or 就地更新
  function sameRowSet(servers) {
    var rows = document.querySelectorAll('#rows tr.row[data-name]');
    if (rows.length !== servers.length) return false;
    for (var i = 0; i < servers.length; i++) {
      if ((servers[i].name || '') !== rows[i].getAttribute('data-name')) return false;
    }
    return true;
  }

  // 就地更新: 非进度条单元格直接换内容, 进度条复用元素改宽度(动画)
  function updateRows(servers) {
    var rowsEl = document.getElementById('rows');
    var rows = rowsEl.querySelectorAll('tr.row[data-name]');
    var map = {};
    for (var i = 0; i < rows.length; i++) map[rows[i].getAttribute('data-name')] = rows[i];
    for (var k = 0; k < servers.length; k++) {
      var s = servers[k], tr = map[s.name || ''];
      if (!tr) continue;
      var c = computeCells(s), gv = { 9: c.cpu, 10: c.mem, 11: c.hdd };
      tr.classList.toggle('offline', !c.online);
      var tds = tr.children;
      for (var t = 0; t < tds.length && t < 15; t++) {
        if (GAUGE_COL[t]) updateGauge(tds[t], GAUGE_COL[t], gv[t], c.online);
        else tds[t].innerHTML = c.cells[t];
      }
      var ex = tr.nextElementSibling;
      if (ex && ex.classList && ex.classList.contains('exrow')) ex.firstElementChild.innerHTML = detailHTML(s);
    }
  }

  // 新建的进度条下一帧从 0 设到目标宽度, 触发 CSS 过渡(初次加载/上线时的增长动画)
  function flushNewBars() {
    var bars = document.querySelectorAll('#rows i.bar-fill[data-w]');
    for (var i = 0; i < bars.length; i++) {
      bars[i].style.width = bars[i].getAttribute('data-w');
      bars[i].removeAttribute('data-w');
    }
  }

  function render(j) {
    var servers = (j && j.servers) || [];
    S.servers = servers;
    var rowsEl = document.getElementById('rows');
    if (!servers.length) {
      rowsEl.innerHTML = '<tr class="empty"><td colspan="15">No nodes yet</td></tr>';
    } else if (sameRowSet(servers)) {
      updateRows(servers);                 // 同一批节点: 就地更新, 进度条平滑过渡
    } else {
      rowsEl.innerHTML = servers.map(function (s) { return row(s) + exrow(s); }).join('');
    }

    var on = 0;
    for (var i = 0; i < servers.length; i++) if (servers[i].online4 || servers[i].online6) on++;
    document.getElementById('summary').innerHTML =
      '<b>' + on + '</b> online / <b>' + servers.length + '</b> total';

    if (j && j.updated) {
      var d = new Date(j.updated * 1000);
      document.getElementById('updated').textContent = 'Updated ' + d.toLocaleTimeString();
    }

    applyExpanded();
    requestAnimationFrame(flushNewBars);
  }

  function tick() {
    fetch('json/stats.json?_=' + Date.now(), { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(render)
      .catch(function () { /* keep last view on transient errors */ });
  }

  /* ----------------- expandable detail row (老站手风琴式: 点击行就地展开) ----------------- */
  function findServer(name) {
    for (var i = 0; i < S.servers.length; i++) if ((S.servers[i].name || '') === name) return S.servers[i];
    return null;
  }
  function pingPart(t, l) {
    t = Number(t); l = Number(l);
    return (isNaN(t) ? 0 : t) + 'ms (' + (isNaN(l) ? 0 : Math.round(l)) + '%)';
  }
  function seg(label, val) { return '<span class="exseg"><b>' + label + '</b>' + val + '</span>'; }

  function detailHTML(s) {
    var KB = 1024, MB = 1048576;
    var io = humanSpeed(s.io_read) + ' / ' + humanSpeed(s.io_write);
    return '<div class="exwrap">'
      + seg('Network ↓|↑', humanSpeed(s.network_rx) + ' / ' + humanSpeed(s.network_tx))
      + seg('Memory|Swap', humanBytes((Number(s.memory_used) || 0) * KB) + ' / ' + humanBytes((Number(s.memory_total) || 0) * KB) + ' | ' + humanBytes((Number(s.swap_used) || 0) * KB) + ' / ' + humanBytes((Number(s.swap_total) || 0) * KB))
      + seg('Disk|IO', humanBytes((Number(s.hdd_used) || 0) * MB) + ' / ' + humanBytes((Number(s.hdd_total) || 0) * MB) + ' | ' + io)
      + seg('TCP/UDP/Proc/Thread', (Number(s.tcp_count) || 0) + ' / ' + (Number(s.udp_count) || 0) + ' / ' + (Number(s.process_count) || 0) + ' / ' + (Number(s.thread_count) || 0))
      + seg('CU/CT/CM', pingPart(s.time_10010, s.ping_10010) + ' / ' + pingPart(s.time_189, s.ping_189) + ' / ' + pingPart(s.time_10086, s.ping_10086))
      + '</div>';
  }
  function exrow(s) {
    var name = s.name || '';
    var open = (s.online4 || s.online6) && S.expanded[name];
    return '<tr class="exrow" data-for="' + esc(name) + '"' + (open ? '' : ' hidden') + '><td colspan="15">' + detailHTML(s) + '</td></tr>';
  }
  function applyExpanded() {
    var rows = document.querySelectorAll('#rows .exrow');
    for (var i = 0; i < rows.length; i++) {
      var n = rows[i].getAttribute('data-for');
      var open = !!S.expanded[n];
      if (open) rows[i].removeAttribute('hidden'); else rows[i].setAttribute('hidden', '');
      var main = rows[i].previousElementSibling;   // 对应主行: 展开时隐藏二者之间的分隔线
      if (main && main.classList && main.classList.contains('row')) main.classList.toggle('open', open);
    }
  }
  function toggleExpand(name) {
    var s = findServer(name);
    if (!s || !(s.online4 || s.online6)) return;   // 离线节点不展开(同老站)
    if (S.expanded[name]) delete S.expanded[name]; else S.expanded[name] = true;
    applyExpanded();
  }
  function initExpand() {
    document.getElementById('rows').addEventListener('click', function (e) {
      var tr = e.target.closest('tr.row[data-name]');
      if (tr) toggleExpand(tr.getAttribute('data-name'));
    });
  }

  /* ----------------- boot ----------------- */
  initTheme();
  initExpand();
  tick();
  setInterval(tick, 1500);
})();
