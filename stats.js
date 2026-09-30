/* 统计页：把 data/races.js 现算成 概览 / 年度 / 组别 / 最好成绩 / 等级 / 数据口径。
   页面上不写死任何统计数字 —— Notion 里加一场、跑一次 sync.py，刷新就是最新的。

   三层分工，计算与拼串都不碰 DOM，数据一律走参数传入（所以能用 node 直接测）：
     归一化 → 计算（纯函数）→ 拼 HTML（纯函数）→ mount() 唯一碰 DOM 的地方。

   缺失值一律沉底，沿用明细页的规则（见 format.js 的 rankOf）。 */

/* 「省会」标签 = 地图的收录开关。权威白名单在 sync.py 的 KEEP_TAGS 里，
   这里只是读它写出来的标签；地图页 app.js 也有一份同名常量。 */
const CAPITAL_TAG = '省会';

/* 每个组别列几场最好成绩 */
const PB_COUNT = 3;

/* ---------------- 归一化 ---------------- */
function statRows(raw) {
  return (raw || []).map((r) => {
    const net = Number(r.netSec);
    return {
      date: String(r.date || '').trim(),
      name: String(r.name || ''),
      city: String(r.city || '').trim(),
      year: r.year ? String(r.year) : '',
      group: r.group || '',
      netSec: net > 0 ? net : null,
      waLevel: r.waLevel || '',
      cnLevel: r.cnLevel || '',
      tags: Array.isArray(r.tags) ? r.tags : [],
      hasCapital: !!String(r.capital || '').trim(),
      hasVideo: !!safeHref(r.videoUrl),
      hasUrl: !!safeHref(r.url),
    };
  });
}

/* 按顺序表排：表里的按表序，未收录的排在表里最后一项之后，缺失的沉底。
   rankOf 对缺失给的是 -1（在明细页里配合「缺失沉底」的另一套判断用），这里得单独抬到最后。 */
function byRank(order, pick) {
  const key = (row) => {
    const v = pick(row);
    return v ? rankOf(order, v) : Number.MAX_SAFE_INTEGER;
  };
  return (a, b) => key(a) - key(b);
}

/* ---------------- 各块统计 ---------------- */
/* 只认 YYYY-MM… 开头的日期，跨度用月份相减算，不建 Date —— 免得踩时区边界 */
const DATE_RE = /^\d{4}-\d{2}/;

function monthIndex(date) {
  return Number(date.slice(0, 4)) * 12 + (Number(date.slice(5, 7)) - 1);
}

function spanText(months) {
  const y = Math.floor(months / 12);
  const m = months % 12;
  return [y ? `${y} 年` : '', m ? `${m} 个月` : ''].filter(Boolean).join(' ') || '不足 1 个月';
}

function overviewStats(rows) {
  const cities = new Set();
  for (const r of rows) if (r.city) cities.add(r.city);
  const dates = rows.map((r) => r.date).filter((d) => DATE_RE.test(d)).sort();
  let rangeText = '—';
  let monthsText = '—';
  if (dates.length) {
    const first = dates[0];
    const last = dates[dates.length - 1];
    rangeText = `${first.slice(0, 7)} → ${last.slice(0, 7)}`;
    monthsText = spanText(monthIndex(last) - monthIndex(first));
  }
  return { total: rows.length, cities: cities.size, rangeText, monthsText };
}

function yearStats(rows) {
  const counts = tally(rows, (r) => [r.year]);
  const buckets = [...counts.entries()]
    .filter(([year]) => year)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([year, count]) => ({ year, count }));
  const max = buckets.reduce((m, b) => Math.max(m, b.count), 0);
  // 条形长度按最多的那年归一，不是占总场次的比；空数据时 max 为 0，不能除
  for (const b of buckets) b.pct = max ? (b.count / max) * 100 : 0;
  return { buckets, missing: counts.get('') || 0 };
}

function groupStats(rows) {
  const counts = tally(rows, (r) => [r.group]);
  return [...counts.entries()]
    .map(([group, count]) => ({
      group,
      zh: groupText(group),
      count,
      pct: rows.length ? (count / rows.length) * 100 : 0,
    }))
    .sort(byRank(GROUP_ORDER, (g) => g.group));
}

/* 每个组别各自比净成绩，绝不跨组别出「总最快」—— 全马和十公里没有可比性。
   组内按净成绩升序；并列取日期更早的，再并列按赛事名，结果才是确定的。 */
function pbStats(rows) {
  const byGroup = new Map();
  for (const r of rows) {
    if (!byGroup.has(r.group)) byGroup.set(r.group, []);
    byGroup.get(r.group).push(r);
  }
  const list = [];
  for (const [group, races] of byGroup) {
    const timed = races
      .filter((r) => r.netSec !== null)
      .sort((a, b) => a.netSec - b.netSec ||
        (a.date === b.date ? 0 : a.date < b.date ? -1 : 1) ||
        a.name.localeCompare(b.name, 'zh-Hans-CN'));
    list.push({
      group,
      zh: groupText(group),
      top: timed.slice(0, PB_COUNT).map((r) => ({ secText: hms(r.netSec), name: r.name, date: r.date })),
    });
  }
  return list.sort(byRank(GROUP_ORDER, (g) => g.group));
}

/* 等级分布两栏共用：世田联用中文字典，中田协沿用原文（A / B / C） */
function levelStats(rows, pick, order, decorate) {
  const counts = tally(rows, (r) => [pick(r)]);
  const buckets = [...counts.entries()]
    .filter(([value]) => value)
    .map(([value, count]) => ({ value, label: decorate(value), count }))
    .sort(byRank(order, (b) => b.value));
  return { buckets, missing: counts.get('') || 0 };
}

function coverageStats(rows) {
  const count = (fn) => rows.filter(fn).length;
  return {
    total: rows.length,
    cities: count((r) => r.city),
    capitals: count((r) => r.hasCapital),
    capitalTag: count((r) => r.tags.includes(CAPITAL_TAG)),
    videos: count((r) => r.hasVideo),
    urls: count((r) => r.hasUrl),
  };
}

/* ---------------- 拼 HTML ---------------- */
function kpiHtml(value, label) {
  // 大数字用比例字形，不加 tabular-nums —— 等宽会让大字号看着发散
  return `<div class="kpi"><span class="kpi-n">${esc(value)}</span><span class="kpi-l">${esc(label)}</span></div>`;
}

function kpisHtml(ov) {
  return kpiHtml(ov.total, '完赛场次') +
    kpiHtml(ov.cities, '完赛城市') +
    kpiHtml(ov.monthsText, ov.rangeText);
}

function barsHtml(yr) {
  let html = '';
  for (const b of yr.buckets) {
    html += `<div class="bar-row" title="${esc(b.year)} 年 ${b.count} 场">` +
      `<span class="bar-label">${esc(b.year)} 年</span>` +
      // 轨道是纯装饰（数字本身就是文本），读屏跳过
      `<span class="bar-track" aria-hidden="true">` +
      `<span class="bar-fill" style="width:${b.pct.toFixed(1)}%"></span></span>` +
      `<span class="bar-value">${b.count}</span></div>`;
  }
  if (yr.missing) html += `<p class="muted-note">另有 ${yr.missing} 场没填年份，未画进条形。</p>`;
  return html;
}

function groupsHtml(groups) {
  let html = '<div class="table-wrap"><table><thead><tr><th>组别</th><th>场次</th><th>占比</th></tr></thead><tbody>';
  for (const g of groups) {
    html += `<tr><td>${esc(g.zh)}</td><td>${g.count}</td><td>${g.pct.toFixed(1)}%</td></tr>`;
  }
  return html + '</tbody></table></div>';
}

function pbHtml(pb) {
  let html = '<div class="table-wrap"><table><thead><tr><th>组别</th><th>净成绩</th><th>赛事</th><th>日期</th></tr></thead><tbody>';
  for (const g of pb) {
    if (!g.top.length) {
      html += `<tr><td class="pb-group">${esc(g.zh)}</td><td colspan="3">没有净成绩记录</td></tr>`;
      continue;
    }
    // 组别用 rowspan 覆盖本组各行，省得一列全是重复的组名
    g.top.forEach((t, i) => {
      html += '<tr>' +
        (i === 0 ? `<td class="pb-group" rowspan="${g.top.length}">${esc(g.zh)}</td>` : '') +
        `<td>${esc(t.secText)}</td><td>${esc(t.name)}</td><td>${esc(t.date) || '—'}</td></tr>`;
    });
  }
  return html + '</tbody></table></div>';
}

function levelColHtml(title, missingLabel, s) {
  let html = `<div class="level-col"><h3>${esc(title)}</h3><table><tbody>`;
  for (const b of s.buckets) {
    html += `<tr><td>${esc(b.label)}</td><td class="num">${b.count}</td></tr>`;
  }
  if (s.missing) html += `<tr class="miss"><td>${esc(missingLabel)}</td><td class="num">${s.missing}</td></tr>`;
  return html + '</tbody></table></div>';
}

function levelsHtml(wa, cn) {
  return '<div class="level-grid">' +
    levelColHtml('世界田联', '未打标', wa) +
    levelColHtml('中国田协', '未填', cn) +
    '</div>';
}

/* 这些就是原先写在 README 里的口径数字，以后只在页面上活。
   地图收录要「省会」标签 + 赛事名含省会城市两条都满足，那条判断在地图页，这里不重复实现。 */
function coverageText(cv) {
  return `数据口径：城市可解析 ${cv.cities}/${cv.total} · ` +
    `赛事名含省会城市 ${cv.capitals} 场 · ` +
    `打了「省会」标签 ${cv.capitalTag} 场（上地图还要赛事名含省会城市，两条都满足才算，以地图页为准） · ` +
    `有视频 ${cv.videos} 场 · 有成绩页 ${cv.urls} 场`;
}

/* ---------------- 挂载 ---------------- */
function mount() {
  const rows = statRows(window.RACES);
  if (!rows.length) {
    document.getElementById('kpis').innerHTML =
      '<p class="empty-tip">还没有记录。请在 Notion 里记一场完赛，然后跑 <code>python3 sync.py</code>。</p>';
    return;
  }
  document.getElementById('kpis').innerHTML = kpisHtml(overviewStats(rows));
  document.getElementById('years').innerHTML = barsHtml(yearStats(rows));
  document.getElementById('groups').innerHTML = groupsHtml(groupStats(rows));
  document.getElementById('pb').innerHTML = pbHtml(pbStats(rows));
  document.getElementById('levels').innerHTML = levelsHtml(
    levelStats(rows, (r) => r.waLevel, WA_ORDER, waLevelText),
    levelStats(rows, (r) => r.cnLevel, CN_ORDER, (v) => v),
  );
  document.getElementById('coverage').textContent = coverageText(coverageStats(rows));
}

window.addEventListener('DOMContentLoaded', () => {
  applyThemePreference();
  // 配色全走 CSS 变量，换主题不用重画，所以这里只切主题、不重新 mount
  document.getElementById('theme-toggle').addEventListener('click', () => {
    setTheme(isDark() ? 'light' : 'dark');
  });
  mount();
});
