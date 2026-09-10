/* 明细页：把 data/races.js 里全部完赛场次列成一张可筛选、可排序的表格。
   数据来自 Notion，字段是可能缺的（城市认不出、没打等级、没标签），
   所以每列都要接受「没有值」——缺失显示「—」，排序时不分升降序一律沉底。 */

/* 缺失值在筛选里的档位：无标签 / 未填组别 / 年份未知 */
const NONE = '__none__';

/* 排序用的字面顺序：组别按距离、等级按高低。
   不能用拼音序 ——「白金标 / 标牌 / 精英标」按拼音排出来是乱的，等于没排。 */
const GROUP_ORDER = ['Full Marathon', 'Half Marathon', '10KM', 'Trail Run'];
const WA_ORDER = ['Platinum Label', 'Gold Label', 'Elite Label', 'Label'];
const CN_ORDER = ['A1', 'A2', 'A', 'B', 'C'];   // 中田协等级，A1 最高

const state = {
  q: '',
  groups: new Set(),
  tags: new Set(),
  years: new Set(),
  sortKey: 'date',
  sortDir: 'desc',      // 默认按日期倒序，最新在最上
};

/* ---------------- 数据 ---------------- */
/* 每场一行：原始值留着排序，展示文本留着渲染，免得两处各算一遍 */
function buildRows() {
  return (window.RACES || []).map((r) => {
    const net = Number(r.netSec);
    const pace = Number(r.paceSec);
    const tags = Array.isArray(r.tags) ? r.tags : [];
    return {
      date: String(r.date || '').trim(),
      name: String(r.name || ''),
      city: String(r.city || '').trim(),
      year: r.year ? String(r.year) : '',
      group: r.group || '',
      netSec: net > 0 ? net : null,
      paceSec: pace > 0 ? pace : null,
      cnLevel: r.cnLevel || '',
      waLevel: r.waLevel || '',
      tags,
      videoUrl: safeHref(r.videoUrl),
      videoStatus: String(r.videoStatus || ''),
      url: safeHref(r.url),
      groupZh: groupText(r.group),
      waZh: waLevelText(r.waLevel),
      tagsText: tags.join(' · '),
    };
  });
}

/* ---------------- 列定义 ----------------
   表头、排序取值、单元格渲染都读这一张表，三处共用一份列清单。 */
function linkCell(url, text, title) {
  if (!url) return '—';
  return `<a href="${esc(url)}" target="_blank" rel="noopener"` +
    (title ? ` title="${esc(title)}"` : '') + `>${esc(text)}</a>`;
}
function tagsCell(r) {
  if (!r.tags.length) return '—';
  return r.tags.map((t) => `<span class="tag-pill">${esc(t)}</span>`).join('');
}

const COLUMNS = [
  { key: 'date', label: '日期', type: 'text', get: (r) => r.date, cell: (r) => esc(r.date) || '—' },
  { key: 'name', label: '赛事名', type: 'text', get: (r) => r.name, cell: (r) => esc(r.name) },
  { key: 'city', label: '城市', type: 'text', get: (r) => r.city, cell: (r) => esc(r.city) || '—' },
  { key: 'group', label: '组别', type: 'rank', order: GROUP_ORDER, get: (r) => r.group, cell: (r) => esc(r.groupZh) },
  { key: 'net', label: '净成绩', type: 'num', get: (r) => r.netSec, cell: (r) => (r.netSec ? hms(r.netSec) : '—') },
  { key: 'pace', label: '配速', type: 'num', get: (r) => r.paceSec, cell: (r) => (r.paceSec ? paceText(r.paceSec) : '—') },
  { key: 'wa', label: '世界田联等级', type: 'rank', order: WA_ORDER, get: (r) => r.waLevel, cell: (r) => esc(r.waZh) },
  { key: 'cn', label: '中国田协等级', type: 'rank', order: CN_ORDER, get: (r) => r.cnLevel, cell: (r) => esc(r.cnLevel || '—') },
  { key: 'tags', label: '标签', type: 'text', get: (r) => r.tagsText, cell: tagsCell },
  { key: 'video', label: '视频', type: 'link', get: (r) => r.videoUrl, cell: (r) => linkCell(r.videoUrl, '▶', r.videoStatus) },
  { key: 'url', label: '成绩页', type: 'link', get: (r) => r.url, cell: (r) => linkCell(r.url, '成绩页', '') },
];

/* ---------------- 排序 ---------------- */
/* 等级在顺序表里的位置；认不出的值排在已认识之后、缺失之前 */
function rankOf(order, value) {
  if (!value) return -1;
  const i = order.indexOf(value);
  return i < 0 ? order.length : i;
}

function isMissing(col, r) {
  const v = col.get(r);
  if (col.type === 'link') return !v;
  if (col.type === 'num') return !(v > 0);
  if (col.type === 'rank') return rankOf(col.order, v) < 0;
  return !String(v || '').trim();
}

function compare(col, a, b) {
  const missA = isMissing(col, a);
  const missB = isMissing(col, b);
  if (missA !== missB) return missA ? 1 : -1;
  if (missA) return 0;
  if (col.type === 'num') return col.get(a) - col.get(b);
  if (col.type === 'rank') return rankOf(col.order, col.get(a)) - rankOf(col.order, col.get(b));
  if (col.type === 'link') return 0;         // 两边都有链接，交给兜底比较
  return String(col.get(a)).localeCompare(String(col.get(b)), 'zh-Hans-CN');
}

function sortRows(rows) {
  const col = COLUMNS.find((c) => c.key === state.sortKey) || COLUMNS[0];
  const dir = state.sortDir === 'asc' ? 1 : -1;
  const dateCol = COLUMNS[0];
  const nameCol = COLUMNS[1];
  return rows.slice().sort((a, b) =>
    dir * compare(col, a, b) ||
    -compare(dateCol, a, b) ||               // 同值时按日期倒序兜底，结果才是确定的
    compare(nameCol, a, b));
}

/* ---------------- 筛选 ---------------- */
function matches(r) {
  if (state.groups.size && !state.groups.has(r.group || NONE)) return false;
  if (state.years.size && !state.years.has(r.year || NONE)) return false;
  if (state.tags.size) {
    const hit = r.tags.some((t) => state.tags.has(t)) || (!r.tags.length && state.tags.has(NONE));
    if (!hit) return false;
  }
  const q = state.q.trim().toLowerCase();
  if (q) {
    // 把中文组别也放进被搜的文本里：搜「半马」等于半马筛选。
    // 注意不能按逗号拆 tags —— 标签原文里就允许有逗号。
    const hay = [r.name, r.city, r.date, r.groupZh, r.tagsText].join(' ').toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}

function activeCount() {
  return state.groups.size + state.tags.size + state.years.size + (state.q.trim() ? 1 : 0);
}

/* ---------------- 筛选控件 ---------------- */
/* chips 从数据里汇总，不写死任何选项：Notion 加组别页面自动出现新 chip；
   标签不会——只有 sync.py 的 KEEP_TAGS 里的标签才会进数据文件（见 README）。
   数字是全集里的场次数（静态），不随其他筛选变化 —— 动态计数会出现「0」，反而费解。 */
function tally(rows, pick) {
  const counts = new Map();
  for (const r of rows) for (const v of pick(r)) counts.set(v, (counts.get(v) || 0) + 1);
  return counts;
}

const NONE_LABEL = { groups: '未填组别', tags: '无标签', years: '年份未知' };

function chipHtml(dim, value, label, count) {
  return `<button class="chip" type="button" data-dim="${dim}" data-val="${esc(value)}" aria-pressed="false">` +
    `${esc(label)}<span class="chip-n">${count}</span></button>`;
}

function chipsFor(dim, counts, decorate, order) {
  const entries = [...counts.entries()].filter(([v]) => v !== NONE);
  entries.sort(order);
  const html = entries.map(([v, n]) => chipHtml(dim, v, decorate(v), n)).join('');
  const none = counts.get(NONE);
  return html + (none ? chipHtml(dim, NONE, NONE_LABEL[dim], none) : '');
}

function filtersHtml(rows) {
  const groups = tally(rows, (r) => [r.group || NONE]);
  const tags = tally(rows, (r) => (r.tags.length ? r.tags : [NONE]));
  const years = tally(rows, (r) => [r.year || NONE]);

  const groupOf = (v) => { const i = GROUP_ORDER.indexOf(v); return i < 0 ? GROUP_ORDER.length : i; };

  return '' +
    '<div class="filter-row">' +
      '<input type="search" id="q" placeholder="搜赛事名 / 城市 / 标签…" aria-label="关键字搜索">' +
      '<button id="clear" class="tool-btn" type="button" disabled>清空筛选</button>' +
    '</div>' +
    `<div class="filter-row"><span class="filter-label">组别</span>` +
      chipsFor('groups', groups, groupText, (a, b) => groupOf(a[0]) - groupOf(b[0])) + '</div>' +
    `<div class="filter-row"><span class="filter-label">标签</span>` +
      chipsFor('tags', tags, (v) => v, (a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-Hans-CN')) + '</div>' +
    `<div class="filter-row"><span class="filter-label">年份</span>` +
      chipsFor('years', years, (v) => v + ' 年', (a, b) => b[0].localeCompare(a[0])) + '</div>';
}

/* 只改选中态、不重画整个筛选区 —— 重画会让搜索框失焦、中文输入法组词被打断 */
function syncFilters() {
  for (const el of document.querySelectorAll('#filters .chip')) {
    const set = state[el.dataset.dim];
    el.setAttribute('aria-pressed', set.has(el.dataset.val) ? 'true' : 'false');
  }
  document.getElementById('clear').disabled = activeCount() === 0;
}

/* ---------------- 渲染 ---------------- */
function tableHtml(rows) {
  if (!rows.length) {
    return '<p class="empty-tip">没有符合当前筛选的场次，试试减少条件或点「清空筛选」。</p>';
  }
  let html = '<div class="table-wrap"><table><thead><tr>';
  for (const c of COLUMNS) {
    const active = c.key === state.sortKey;
    const asc = state.sortDir === 'asc';
    const sort = active ? (asc ? 'ascending' : 'descending') : 'none';
    html += `<th aria-sort="${sort}"><button class="th-btn" type="button" data-key="${c.key}">${c.label}` +
      (active ? `<span class="sort-ind">${asc ? '↑' : '↓'}</span>` : '') + '</button></th>';
  }
  html += '</tr></thead><tbody>';
  for (const r of rows) {
    html += '<tr>' + COLUMNS.map((c) => `<td>${c.cell(r)}</td>`).join('') + '</tr>';
  }
  return html + '</tbody></table></div>';
}

function renderList() {
  const all = buildRows();
  const shown = sortRows(all.filter(matches));
  const n = activeCount();
  document.getElementById('count').innerHTML =
    `共 <b>${all.length}</b> 场` + (n ? `，当前筛选出 <b>${shown.length}</b> 场（${n} 个条件）` : '');
  document.getElementById('list').innerHTML = tableHtml(shown);
}

/* ---------------- 交互 ---------------- */
function toggleChip(chip) {
  const set = state[chip.dataset.dim];
  const value = chip.dataset.val;
  if (set.has(value)) set.delete(value);
  else set.add(value);
  syncFilters();
  renderList();
}

function setSort(key) {
  if (state.sortKey === key) {
    state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
  } else {
    state.sortKey = key;
    // 换列时的初值：日期要「最新在最上」，其余一律升序 ——
    // 净成绩/配速点第一下就是最快在前，等级点第一下就是白金标在前。
    state.sortDir = key === 'date' ? 'desc' : 'asc';
  }
  renderList();
}

function clearFilters() {
  state.q = '';
  state.groups.clear();
  state.tags.clear();
  state.years.clear();
  document.getElementById('q').value = '';
  syncFilters();
  renderList();
}

/* ---------------- 启动 ---------------- */
window.addEventListener('DOMContentLoaded', () => {
  applyThemePreference();
  // 明细页是纯 CSS 变量配色，换主题不用重画表格，所以这里不共用地图页那套 chart 重绘
  document.getElementById('theme-toggle').addEventListener('click', () => {
    setTheme(isDark() ? 'light' : 'dark');
  });

  const rows = buildRows();
  document.getElementById('filters').innerHTML = filtersHtml(rows);
  document.getElementById('filters').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (chip) return toggleChip(chip);
    if (e.target.closest('#clear')) clearFilters();
  });
  document.getElementById('filters').addEventListener('input', (e) => {
    if (e.target.id !== 'q') return;
    state.q = e.target.value;
    syncFilters();
    renderList();
  });
  document.getElementById('list').addEventListener('click', (e) => {
    const btn = e.target.closest('.th-btn');
    if (btn) setSort(btn.dataset.key);
  });

  syncFilters();
  renderList();
});
