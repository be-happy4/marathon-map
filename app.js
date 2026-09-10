/* 省会马拉松足迹地图 —— 应用逻辑 */

/* 城市(省会城市/直辖市) -> 底图中的省份全称 */
const CAPITAL_TO_PROVINCE = {
  北京: '北京市', 天津: '天津市', 上海: '上海市', 重庆: '重庆市',
  石家庄: '河北省', 太原: '山西省', 呼和浩特: '内蒙古自治区',
  沈阳: '辽宁省', 长春: '吉林省', 哈尔滨: '黑龙江省',
  南京: '江苏省', 杭州: '浙江省', 合肥: '安徽省', 福州: '福建省',
  南昌: '江西省', 济南: '山东省', 郑州: '河南省', 武汉: '湖北省',
  长沙: '湖南省', 广州: '广东省', 南宁: '广西壮族自治区',
  海口: '海南省', 成都: '四川省', 贵阳: '贵州省', 昆明: '云南省',
  拉萨: '西藏自治区', 西安: '陕西省', 兰州: '甘肃省', 西宁: '青海省',
  银川: '宁夏回族自治区', 乌鲁木齐: '新疆维吾尔自治区',
  台北: '台湾省', 香港: '香港特别行政区', 澳门: '澳门特别行政区',
};

/* 省份全称 -> 页面上用到的短名（如 “广西壮族自治区”→“广西”） */
function shortProvince(full) {
  return full
    .replace('壮族自治区', '').replace('回族自治区', '').replace('维吾尔自治区', '')
    .replace('自治区', '').replace('特别行政区', '').replace('省', '').replace('市', '');
}

/* ---------------- 底图裁剪 ----------------
   省会马拉松只到省级行政中心，底图里与挑战无关的要素会把包围盒往南拉、主图被迫缩小，先剔掉：
     1. 一个无名要素（adchar=JD，即九段线，10 个环）；
     2. 海南省名下的南沙群岛小岛（该要素 133 个环，绝大多数在低纬度）。

   注意：右下角那个方框不在这份底图数据里 —— echarts 打包代码里有一段硬编码，
   凡是注册名为 "china" 的地图，都会自动追加一个 lon 126–132 / lat 18.4–25 的「南海诸岛」区域
   （源码分支：mapName === "china" 时 push 该区域，并给台湾补钓鱼岛多边形、微调广东/香港/澳门/天津标签）。
   所以下面用 MAP_NAME 换个名字注册，绕开这段注入；代价是不再有那两处自动补充。

   剔掉后包围盒北界 53.6°N 不变、南界从 3.4°N 收到 18.1°N，主图按高度自适应、自动放大。 */
const MAP_NAME = 'china-mainland';
const SOUTH_EDGE_LAT = 17.5; // 海南岛最南端约 18.1°N，以南只剩三沙诸岛

function maxLat(coords) {
  let top = -90;
  (function walk(c) {
    if (typeof c[0] === 'number') { if (c[1] > top) top = c[1]; return; }
    for (const item of c) walk(item);
  })(coords);
  return top;
}

function mainlandGeojson() {
  const geo = window.CHINA_MAP_GEO;
  const features = [];
  for (const f of geo.features) {
    const name = f.properties && f.properties.name;
    if (!name) continue;                       // 无名的九段线 / 南海诸岛框
    if (name !== '海南省') { features.push(f); continue; }
    // 海南省：只留海南岛，丢掉南沙诸岛的小环
    const kept = f.geometry.coordinates.filter((poly) => maxLat(poly) >= SOUTH_EDGE_LAT);
    features.push({ ...f, geometry: { ...f.geometry, coordinates: kept } });
  }
  return { ...geo, features };
}

/* 视觉主题色（浅色用已验证蓝色序列到 700 档，深色封顶 600 档防止融入底图） */
const THEME = {
  light: {
    emptyProvince: '#efeeea',
    border: 'rgba(11,11,11,0.12)',
    maxStepIndex: 9,          // 允许到 #0d366b
  },
  dark: {
    emptyProvince: '#282826',
    border: 'rgba(255,255,255,0.10)',
    maxStepIndex: 7,          // 最深只到 #184f95
  },
};
const SEQUENTIAL_STEPS = ['#86b6ef', '#6da7ec', '#5598e7', '#3987e5', '#2a78d6', '#256abf', '#1c5cab', '#184f95', '#104281', '#0d366b'];

/* ---------------- 数据加工 ----------------
   hms / paceText / waLevelText / groupText / esc 在 format.js 里（两页共用），
   下面只留地图这一个视图自己要用到的。 */
/* 秒 -> 地图标签上的紧凑写法："2:49:19" -> "249"（省略冒号和秒，省空间） */
function hmm(sec) {
  return String(Math.floor(sec / 3600) * 100 + Math.floor((sec % 3600) / 60));
}

/* data/races.js 存的是全部完赛场次，地图只画标签里有一项精确等于「省会」的
   （「省会半马」不算）。哪场进地图由 Notion 标签决定，这里不按组别再筛。 */
const CAPITAL_TAG = '省会';
function capitalRaces() {
  return (window.RACES || []).filter((r) => (r.tags || []).includes(CAPITAL_TAG));
}

function aggregate() {
  const byProvince = {};       // 省份全称 -> { full, short, count, years:Set, fastestSec }
  const unmatched = [];        // 打了「省会」标签、城市却没认出来的记录
  for (const r of capitalRaces()) {
    // 认省份用的是 capital（赛事名里出现过省会城市），不是 city（举办地级市）——
    // 「西湖半马」的 city 是杭州，但按命名口径它不该算作杭州，详见 sync.py 的 find_capital。
    const full = CAPITAL_TO_PROVINCE[String(r.capital || '').trim()];
    if (!full) { unmatched.push(r); continue; }
    if (!byProvince[full]) byProvince[full] = { full, short: shortProvince(full), count: 0, years: new Set(), fastestSec: null };
    const p = byProvince[full];
    p.count += 1;
    if (r.year) p.years.add(Number(r.year));
    const net = Number(r.netSec);
    if (net > 0 && (p.fastestSec === null || net < p.fastestSec)) p.fastestSec = net;
  }
  const list = Object.values(byProvince).map((p) => {
    const yearsAsc = [...p.years].sort((a, b) => a - b);
    return {
      ...p,
      yearsAsc,
      fastestText: p.fastestSec === null ? '' : hms(p.fastestSec),
      fastestShort: p.fastestSec === null ? '' : hmm(p.fastestSec),
    };
  });
  list.sort((a, b) => b.count - a.count || a.full.localeCompare(b.full));
  return { list, unmatched, maxCount: list.reduce((m, p) => Math.max(m, p.count), 0) };
}

/* 下方明细：每场比赛一行，按日期倒序（最新在最上；没写日期的沉底）。 */
function raceRows() {
  return capitalRaces()
    .map((r) => {
      const capital = String(r.capital || '').trim();
      if (!CAPITAL_TO_PROVINCE[capital]) return null;   // 名字里没有省会，由 unmatched 另行提示
      const net = Number(r.netSec);
      const pace = Number(r.paceSec);
      return {
        date: String(r.date || '').trim(),
        name: r.name || `${r.year || ''}${capital}`,
        netText: net > 0 ? hms(net) : '—',
        level: waLevelText(r.waLevel),
        paceText: pace > 0 ? paceText(pace) : '—',
        video: r.videoUrl || '',
      };
    })
    .filter(Boolean)
    .sort((a, b) => (a.date === b.date ? 0 : a.date < b.date ? 1 : -1));
}

/* 每个省份对应的连续色(第 k 次，k 从 1 到 maxCount) */
function colorFor(theme, k, maxCount) {
  if (maxCount <= 1) return SEQUENTIAL_STEPS[Math.round(theme.maxStepIndex * 0.35)];
  const stepLen = theme.maxStepIndex + 1;
  const idx = Math.round(((k - 1) / (maxCount - 1)) * (stepLen - 1));
  return SEQUENTIAL_STEPS[idx];
}

/* ---------------- 渲染 ---------------- */
let chart = null;
const infoByFull = {};

function cssVar(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

function render() {
  const dark = isDark();
  const theme = dark ? THEME.dark : THEME.light;
  const ink = cssVar('--ink', dark ? '#ffffff' : '#0b0b0b');
  const secondary = cssVar('--ink-2', dark ? '#c3c2b7' : '#52514e');
  const muted = cssVar('--muted', '#898781');
  const surface = cssVar('--surface', dark ? '#1a1a19' : '#fcfcfb');

  const { list, unmatched, maxCount } = aggregate();
  const byName = {};
  for (const p of list) byName[p.full] = p;

  const seriesData = list.map((p) => ({ name: p.full, value: p.count }));

  const pieces = [];
  for (let k = 1; k <= maxCount; k++) {
    pieces.push({ min: k, max: k, color: colorFor(theme, k, maxCount), label: `${k}场` });
  }

  const option = {
    backgroundColor: surface,
    tooltip: {
      trigger: 'item',
      backgroundColor: cssVar('--surface', surface),
      borderColor: cssVar('--hairline', 'rgba(0,0,0,0.15)'),
      textStyle: { color: ink, fontSize: 13 },
      formatter(p) {
        const info = byName[p.name];
        if (!info || !p.name) return `<b>${p.name || ''}</b><br/>暂未记录省会马拉松`;
        return `<b>${info.short}</b>（${p.name}）<br/>` +
          `完赛场次：${info.count} 场<br/>` +
          (info.fastestText ? `最快用时：${info.fastestText}（净成绩）` : '净成绩未记录');
      },
    },
    visualMap: {
      type: 'piecewise',
      orient: 'vertical',
      left: 12, bottom: 16,
      itemWidth: 14, itemHeight: 12,
      textStyle: { color: secondary, fontSize: 12 },
      pieces,
    },
    series: [{
      type: 'map',
      map: MAP_NAME,
      // 128%：地图按容器短边（高度）等比放大到几乎撑满，再大就会切到东北和海南
      layoutCenter: ['50%', '50%'],
      layoutSize: '128%',
      roam: true,
      scaleLimit: { min: 0.9, max: 10 },
      label: {
        show: true,
        color: ink,
        fontSize: 10,
        lineHeight: 15,
        formatter(p) {
          const info = byName[p.name];
          if (!info || !p.name) return '';
          return info.fastestShort ? `${info.short}\n${info.fastestShort}` : info.short;
        },
      },
      itemStyle: {
        areaColor: theme.emptyProvince,
        borderColor: theme.border,
        borderWidth: 0.6,
      },
      emphasis: {
        label: { show: true, color: ink, fontWeight: 'bold' },
        itemStyle: { areaColor: cssVar('--hover-fill', theme === THEME.dark ? '#3a3a37' : '#e6e4de') },
      },
      data: seriesData,
    }],
  };

  if (!chart) {
    const el = document.getElementById('map');
    chart = echarts.init(el);
  }
  chart.setOption(option, true);

  drawSummary({ list, unmatched, maxCount }, { ink, secondary, muted }, raceRows());
}

/* 页面下方的汇总与明细表 */
function drawSummary({ list, unmatched, maxCount }, colors, rows) {
  const el = document.getElementById('summary');
  const totalCount = list.reduce((s, p) => s + p.count, 0);

  let html = `<div class="stat-line">累计 <b>${list.length}</b> 个省级行政区 · 共 <b>${totalCount}</b> 场完赛省会马拉松</div>`;

  if (rows.length) {
    html += '<div class="table-wrap"><table><thead><tr><th>日期</th><th>赛事完整名称</th><th>净成绩</th><th>等级</th><th>配速</th><th>视频</th></tr></thead><tbody>';
    for (const r of rows) {
      const video = r.video ? `<a href="${esc(r.video)}" target="_blank" rel="noopener">▶</a>` : '—';
      html += `<tr><td>${esc(r.date) || '—'}</td><td>${esc(r.name)}</td><td>${esc(r.netText)}</td><td>${esc(r.level)}</td><td>${esc(r.paceText)}</td><td>${video}</td></tr>`;
    }
    html += '</tbody></table></div>';
  } else {
    html += '<p class="empty-tip">还没有记录。请在 Notion 里给完赛的省会马拉松勾上「省会」标签，然后跑 <code>python3 sync.py</code>。</p>';
  }

  // 本页只画「省会」子集，其余场次在明细页看。场次数用数据现算，别写死。
  const totalRaces = (window.RACES || []).length;
  if (totalRaces) {
    html += `<p class="muted-note"><a class="more-link" href="detail.html">查看全部完赛明细（${totalRaces} 场，可筛选排序）→</a></p>`;
  }

  if (unmatched.length) {
    const parts = unmatched.map((r) => esc(`${r.name}（${r.year ?? '年份未填'}）`));
    html += `<p class="muted-note">以下 ${unmatched.length} 条打了「省会」标签，但赛事名里没有省会城市名，未计入本图：${parts.join('、')}</p>`;
  }

  el.innerHTML = html;
}

/* ---------------- 主题切换 ----------------
   偏好的读写走 format.js 的 isDark/setTheme（和明细页共用同一个 localStorage 键）；
   地图是 canvas，换了主题必须整个重画，这部分是本页独有的。 */
function toggleTheme() {
  setTheme(isDark() ? 'light' : 'dark');
  if (chart) { chart.dispose(); chart = null; }
  render();
}

/* 导出地图当前画面为 PNG（跟随当前主题），文件名带当天日期 */
function exportImage() {
  if (!chart) return;
  const url = chart.getDataURL({ type: 'png', pixelRatio: 2 });
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const name = `省会马拉松足迹-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.png`;
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/* ---------------- 启动 ---------------- */
window.addEventListener('DOMContentLoaded', () => {
  applyThemePreference();
  echarts.registerMap(MAP_NAME, mainlandGeojson());
  document.getElementById('theme-toggle').addEventListener('click', toggleTheme);
  document.getElementById('export-png').addEventListener('click', exportImage);
  render();
  window.addEventListener('resize', () => chart && chart.resize());
});
