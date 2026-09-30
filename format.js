/* 三个页面（index.html / detail.html / stats.html）共用的展示工具：
   把 Notion 里的原始字段变成页面上的文本，外加语义顺序、分组计数、转义和主题偏好。

   普通脚本，不是 ES module —— file:// 下用 import/export 会被 CORS 拦掉，
   双击就打不开。所以各页都靠全局函数共享，**各自的页面脚本必须排在它后面**：
   下面三张顺序表是顶层 const，页面脚本在求值阶段就会读到它们（如 detail.js 的 COLUMNS）。 */

/* ---------------- 成绩 / 配速 ---------------- */
/* 秒 -> "2:49:19" */
function hms(sec) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${Math.floor(sec / 3600)}:${pad(Math.floor((sec % 3600) / 60))}:${pad(sec % 60)}`;
}

/* 每公里配速（秒）-> "4:03" */
function paceText(sec) {
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/* ---------------- 中文字典（Notion 里存的是英文 select） ---------------- */
/* 世界田联标牌等级。没打标的场次（如 2026长春马拉松）显示「—」——
   这一列只看世田联，不退回中田协等级。 */
const WA_LEVEL_ZH = {
  'Platinum Label': '白金标',
  'Gold Label': '金标',
  'Elite Label': '精英标',
  'Label': '标牌',
};
function waLevelText(level) {
  return WA_LEVEL_ZH[level] || level || '—';
}

const GROUP_ZH = {
  'Full Marathon': '全马',
  'Half Marathon': '半马',
  '10KM': '十公里',
  'Trail Run': '越野',
};
function groupText(group) {
  return GROUP_ZH[group] || group || '—';
}

/* ---------------- 语义顺序 ----------------
   组别按距离、等级按高低。不能用拼音序 ——「白金标 / 标牌 / 精英标」按拼音排出来是乱的，
   等于没排。三张表是上面两张中文字典的排序注解：明细页的排序列与统计页的分组都读它。 */
const GROUP_ORDER = ['Full Marathon', 'Half Marathon', '10KM', 'Trail Run'];
const WA_ORDER = ['Platinum Label', 'Gold Label', 'Elite Label', 'Label'];
const CN_ORDER = ['A1', 'A2', 'A', 'B', 'C'];   // 中田协等级，A1 最高

/* 在顺序表里的位置：认不出的值排在已认识之后（order.length），缺失排最前（-1）。
   各页据此把缺失值沉底，与升 / 降序无关。 */
function rankOf(order, value) {
  if (!value) return -1;
  const i = order.indexOf(value);
  return i < 0 ? order.length : i;
}

/* ---------------- 分组计数 ----------------
   pick 返回数组，所以一条记录可以进多个桶（如多个标签）。返回 Map。 */
function tally(rows, pick) {
  const counts = new Map();
  for (const r of rows) for (const v of pick(r)) counts.set(v, (counts.get(v) || 0) + 1);
  return counts;
}

/* ---------------- 转义 / 链接 ---------------- */
/* 两个页面都是拼字符串塞 innerHTML，字段来自 Notion，插值前一律转义 */
function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/* 只放行 http(s)，别的（javascript: 之类）一律当作没有链接 */
function safeHref(url) {
  return /^https?:\/\//i.test(String(url || '')) ? url : '';
}

/* ---------------- 主题偏好 ----------------
   两页共用同一个 localStorage 键，所以在哪页切了，另一页也跟着变。 */
const THEME_KEY = 'mmap-theme';

function applyThemePreference() {
  const stored = localStorage.getItem(THEME_KEY);
  if (stored) document.documentElement.dataset.theme = stored;
}

function isDark() {
  const set = document.documentElement.dataset.theme;
  return set ? set === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
}

function setTheme(value) {
  document.documentElement.dataset.theme = value;
  localStorage.setItem(THEME_KEY, value);
}
