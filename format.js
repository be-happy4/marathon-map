/* 地图页（index.html）与明细页（detail.html）共用的展示工具：
   把 Notion 里的原始字段变成页面上的文本，外加转义和主题偏好。

   普通脚本，不是 ES module —— file:// 下用 import/export 会被 CORS 拦掉，
   双击就打不开。所以两页都靠全局函数共享，各自的页面脚本必须排在它后面。 */

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
