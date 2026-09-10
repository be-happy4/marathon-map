#!/usr/bin/env python3
"""从 Notion「Games」库同步全部已完赛场次到 data/races.js。

本文件是**全部** Completed 场次的完整档案（含半马 / 越野 / 十公里 / 非省会城市），
地图只是它的一个视图：页面按「标签里有一项精确等于『省会』」筛出子集来画。
一场比赛进不进地图，改 Notion 标签即可，不用动代码。

维护流程（唯一真源 = Notion）：
  1. 在 Notion 里把一场比赛标成 Completed（完赛）；要进地图就再勾上「省会」标签。
  2. 运行本脚本：  python3 sync.py
  3. 刷新页面即可（地图页 + 明细页）。

同步字段：城市（从赛事名里解析出的举办地级市，解析不出留空）、赛事名里出现的省会城市
（capital，只有地图用，见 find_capital 的注释）、比赛日期、年份、赛事名、组别、
净成绩（秒，取自 Net Time(Seconds) 公式，缺失时解析 Net Time 文本）、每公里配速（秒）、
中国田协等级、世界田联等级、标签（只留 KEEP_TAGS 里的三个）、视频链接、视频状态、
赛事链接。

运行前需在 .env（或环境变量 NOTION_TOKEN）里提供 Notion integration token。

只依赖 Python 标准库，无第三方包。
"""

import json
import os
import re
import sys
import urllib.request
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
DATA_FILE = BASE_DIR / "data" / "races.js"
ENV_FILE = BASE_DIR / ".env"
API = "https://api.notion.com/v1"
VERSION = "2022-06-28"

# Games 库（Notion「Marathon」页面 → Games）的 database id。
# 如需同步别的库，把它的 id 追加到下面列表即可。
DB_IDS = ["112f87b9-fa54-8055-9383-dde81a334966"]

# Extra Tag 里只保留这三个：省会（地图收录开关）、CMM（中国马拉松大满贯）、
# WMM（世界大满贯）。其余标签（直通、江苏、浙江、省会半马…）在 Notion 里怎么打都行，
# 但不写进数据文件，明细页的标签列与筛选项因此只有这三个。
# 想在页面上按新标签筛选，把名字加进来即可；不加就不会出现（刻意的：标签一多筛选栏就废了）。
KEEP_TAGS = {"省会", "CMM", "WMM"}

# 省会 / 直辖市 / 特别行政区（挑战主线覆盖的那批）。
CAPITALS = {
    "北京", "天津", "上海", "重庆",
    "石家庄", "太原", "呼和浩特",
    "沈阳", "长春", "哈尔滨",
    "南京", "杭州", "合肥", "福州",
    "南昌", "济南", "郑州", "武汉",
    "长沙", "广州", "南宁",
    "海口", "成都", "贵阳", "昆明",
    "拉萨", "西安", "兰州", "西宁",
    "银川", "乌鲁木齐",
    # 港澳台：挑战规则范围含特别行政区（台北参赛路径待定，见 CHALLENGE.md）
    "香港", "澳门", "台北",
}

# 赛事名里可能出现的地名 -> 举办地级市，两个函数都按名字长度从长到短匹配。
#
# 取地级市（不取区县）是刻意的：诸暨归绍兴、奉化归宁波、太仓归苏州，
# 这样一列里不会同时出现「绍兴」和「诸暨」两个层级的名字。
# 地标按所在地归并（西湖 / 湘湖 / 千岛湖 / 黄龙 / 浙大 -> 杭州），认错了改这一行即可。
PLACE_TO_CITY = {
    **{c: c for c in CAPITALS},
    # 非省会：地级市本身
    "绍兴": "绍兴", "宁波": "宁波", "湖州": "湖州",
    "苏州": "苏州", "无锡": "无锡", "扬州": "扬州", "深圳": "深圳",
    # 非省会：区县 / 县级市，归到所属地级市
    "诸暨": "绍兴", "上虞": "绍兴",
    "奉化": "宁波",
    "桐庐": "杭州", "建德": "杭州", "临平": "杭州", "萧山": "杭州", "淳安": "杭州",
    "太仓": "苏州",
    # 地标（按所在地推）：西湖 / 湘湖 / 黄龙体育中心 / 浙江大学 / 千岛湖都在杭州
    "千岛湖": "杭州", "西湖": "杭州", "湘湖": "杭州", "黄龙": "杭州", "浙大": "杭州",
}


def get_token():
    env = os.environ.get("NOTION_TOKEN")
    if env:
        return env.strip()
    if ENV_FILE.exists():
        for line in ENV_FILE.read_text(encoding="utf-8").splitlines():
            key, _, val = line.partition("=")
            if key.strip() == "NOTION_TOKEN" and val.strip():
                return val.strip()
    sys.exit("未找到 Notion token：请在 .env 写入 NOTION_TOKEN=...，或设置环境变量。")


def api(token, method, path, body=None):
    req = urllib.request.Request(API + path, method=method)
    req.add_header("Authorization", f"Bearer {token}")
    req.add_header("Notion-Version", VERSION)
    req.add_header("Content-Type", "application/json")
    data = json.dumps(body).encode() if body is not None else None
    try:
        with urllib.request.urlopen(req, data=data, timeout=30) as resp:
            return json.load(resp)
    except urllib.error.HTTPError as e:
        msg = json.load(e).get("message", e.reason) if e.headers.get("content-type", "").startswith("application/json") else e.reason
        sys.exit(f"Notion API 出错 [{e.code}] {msg}")


def query_db_rows(token, db_id):
    rows, cursor = [], None
    while True:
        body = {"page_size": 100}
        if cursor:
            body["start_cursor"] = cursor
        data = api(token, "POST", f"/databases/{db_id}/query", body)
        rows += data.get("results", [])
        if not data.get("has_more"):
            break
        cursor = data.get("next_cursor")
    return rows


def plain(value):
    if not value:
        return ""
    if isinstance(value, list):
        return "".join(x.get("plain_text", "") for x in value)
    return value


def prop_text(prop):
    """把单个 property 的值压成字符串（title/select/multi_select/date/url/…）。"""
    if not prop:
        return ""
    t = prop["type"]
    v = prop[t]
    if t in ("title", "rich_text"):
        return plain(v)
    if t == "multi_select":
        return ",".join(x["name"] for x in v)
    if t in ("select", "status"):
        return v["name"] if v else ""
    if t == "date":
        if not v:
            return ""
        return v.get("start") or ""
    if t == "url":
        return v or ""
    if t == "number":
        return str(v)
    if t == "formula":
        inner = v.get("type")
        if inner == "number":
            return "" if v.get("number") is None else str(v["number"])
        if inner == "string":
            return v.get("string") or ""
    return ""


def prop_list(prop):
    """multi_select -> 字符串列表（标签要保留成数组，不能压成一个逗号串）。"""
    if not prop or prop["type"] != "multi_select":
        return []
    return [x["name"] for x in prop["multi_select"]]


def kept_tags(prop):
    """Extra Tag -> 只留 KEEP_TAGS 里的（顺序沿用 Notion 里的顺序）。

    不在白名单里的直接丢掉、不进数据文件，所以「直通」「江苏」这类标签不会出现在页面上。
    """
    return [t for t in prop_list(prop) if t in KEEP_TAGS]


def hms_to_seconds(text):
    """'2:54:06' / '2:54' -> 秒数；解析失败返回 None。"""
    parts = text.strip().split(":")
    if not 2 <= len(parts) <= 3:
        return None
    try:
        nums = [float(x) for x in parts]
    except ValueError:
        return None
    total = 0.0
    for n in nums:
        total = total * 60 + n
    return int(total)


def seconds_to_hms(sec):
    return f"{sec // 3600}:{sec % 3600 // 60:02d}:{sec % 60:02d}"


def net_seconds(props):
    """净成绩（秒）：优先 Net Time(Seconds) 公式，缺失时解析 Net Time 文本。"""
    value = prop_text(props.get("Net Time(Seconds)", {}))
    if value:
        try:
            return int(float(value))
        except ValueError:
            pass
    return hms_to_seconds(prop_text(props.get("Net Time", {})))


def pace_seconds(props):
    """每公里配速（秒）：用 Seconds/km 公式的数值（234.96 -> 235）。"""
    value = prop_text(props.get("Seconds/km", {}))
    if not value:
        return None
    try:
        return round(float(value))
    except ValueError:
        return None


def find_city(name):
    """举办地级市（明细页的「城市」列）。认不出返回 None。"""
    for place in sorted(PLACE_TO_CITY, key=len, reverse=True):
        if place in name:
            return PLACE_TO_CITY[place]
    return None


def find_capital(name):
    """赛事名里出现的省会城市（地图只认这个）。

    和 find_city 分开是必要的：「杭州桐庐半程马拉松」的举办地是杭州，但按
    CHALLENGE.md 的命名口径，它不以省会命名，不该算作杭州。同理「西湖半马」
    归杭州，但地图不该把它算进浙江。两条判断各问各的问题，别合并。
    """
    for capital in sorted(CAPITALS, key=len, reverse=True):
        if capital in name:
            return capital
    return None


def races_from_rows(rows):
    """全部 Completed 场次 -> 记录列表；缺年份的单独返回（没法排序，不写入）。"""
    found, undated = [], []
    for row in rows:
        p = row.get("properties", {})
        if prop_text(p.get("Status", {})) != "Completed":
            continue
        name = prop_text(p.get("Name", {})) or prop_text(p.get("title", {}))
        date_str = prop_text(p.get("Date", {}))
        year = re.match(r"^(\d{4})", date_str) or re.match(r"^(\d{4})", name)
        if not year:
            undated.append(name)
            continue
        iso = re.match(r"^(\d{4}-\d{2}-\d{2})", date_str)
        found.append({
            "city": find_city(name) or "",
            "capital": find_capital(name) or "",
            "date": iso.group(1) if iso else "",
            "year": int(year.group(1)),
            "name": name,
            "group": prop_text(p.get("Group", {})),
            "netSec": net_seconds(p),
            "paceSec": pace_seconds(p),
            "cnLevel": prop_text(p.get("Chinese Athletics Level", {})),
            "waLevel": prop_text(p.get("World Athletics Level", {})),
            "tags": kept_tags(p.get("Extra Tag", {})),
            "videoUrl": prop_text(p.get("Video", {})),
            "videoStatus": prop_text(p.get("Video Status", {})),
            "url": prop_text(p.get("URL", {})),
        })
    return found, undated


def js_str(text):
    """包成 JS 单引号字符串（赛事名是自由文本，可能带撇号，直接拼会写坏文件）。"""
    return "'" + str(text).replace("\\", "\\\\").replace("'", "\\'") + "'"


def render_js(races):
    lines = [
        "/* ============================================================",
        "   本文件由 sync.py 自动生成 —— 不要手工编辑。",
        "   内容：Notion「Games」库里全部已完赛（Completed）的场次。",
        "   地图只画其中标签含「省会」的那些；改标签请回 Notion 改。",
        "   更新：  python3 sync.py",
        "   ============================================================ */",
        "",
        "window.RACES = [",
    ]
    for r in races:
        fields = [
            f"city: {js_str(r['city'])}",
        ]
        if r["capital"]:
            fields.append(f"capital: {js_str(r['capital'])}")
        fields += [
            f"date: {js_str(r['date'])}",
            f"year: {r['year']}",
            f"name: {js_str(r['name'])}",
        ]
        if r["group"]:
            fields.append(f"group: {js_str(r['group'])}")
        if r["netSec"]:
            fields.append(f"netSec: {r['netSec']}")
        if r["paceSec"]:
            fields.append(f"paceSec: {r['paceSec']}")
        if r["cnLevel"]:
            fields.append(f"cnLevel: {js_str(r['cnLevel'])}")
        if r["waLevel"]:
            fields.append(f"waLevel: {js_str(r['waLevel'])}")
        if r["tags"]:
            fields.append("tags: [" + ", ".join(js_str(t) for t in r["tags"]) + "]")
        if r["videoUrl"]:
            fields.append(f"videoUrl: {js_str(r['videoUrl'])}")
        if r["videoStatus"]:
            fields.append(f"videoStatus: {js_str(r['videoStatus'])}")
        if r["url"]:
            fields.append(f"url: {js_str(r['url'])}")
        lines.append("  { " + ", ".join(fields) + " },")
    lines.append("];")
    return "\n".join(lines) + "\n"


def main():
    token = get_token()
    rows = []
    for db_id in DB_IDS:
        rows += query_db_rows(token, db_id)

    races, undated = races_from_rows(rows)
    # 按比赛日期排，文件读起来就是一条时间线
    races.sort(key=lambda r: (r["date"] or f"{r['year']}-00-00", r["name"]))

    DATA_FILE.write_text(render_js(races), encoding="utf-8")

    by_group = {}
    for r in races:
        key = r["group"] or "未填组别"
        by_group[key] = by_group.get(key, 0) + 1
    capitals = [r for r in races if "省会" in r["tags"]]

    print(f"已同步：{len(races)} 场完赛场次 → {DATA_FILE}")
    print("  组别：" + " · ".join(f"{g} {n}" for g, n in sorted(by_group.items())))
    print(f"  其中标签含「省会」{len(capitals)} 场，这些才会画到地图上：")
    for r in capitals:
        net = f" 净 {seconds_to_hms(r['netSec'])}" if r["netSec"] else " 净成绩缺失"
        print(f"    - {r['date'] or r['year']}  {r['name']}{net}")
    if undated:
        print("⚠ 以下场次缺年份（赛事名和日期里都没有），未写入：")
        for name in undated:
            print("   ", name)


if __name__ == "__main__":
    main()
