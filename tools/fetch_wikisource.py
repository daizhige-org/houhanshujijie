#!/usr/bin/env python3
"""從中文維基文庫同步《後漢書集解》到 .src/（維基文庫有新的錄入、校對後重新運行，再運行 tools/build.py）。

    主頁                      分部（卷首/紀/列傳/續漢志）、各卷子頁名與篇題
    各卷子頁的 <pages>          冊次與頁碼範圍；個別頁換用他本的，也在這裡
    Page: 頁面的 wikitext       每次 50 頁成批讀取，全書一百多次請求

輸出：

    .src/pages/NN.wiki   每冊一個文件，以「〔第N頁〕」分頁，其後是該頁 wikitext 原樣
    .src/book.json       卷目、頁碼範圍、索引名、掃描圖地址、換用他本的頁

只用標準庫：python3 tools/fetch_wikisource.py
"""
import hashlib
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

API = "https://zh.wikisource.org/w/api.php"
UA = {"User-Agent": "static-reader-build/0.1 (python-urllib)"}
ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / ".src"
WORK = "後漢書集解"
CN = "〇一二三四五六七八九"
FRONT_ID = {"序": "xu", "述略": "shulue", "汲古閣本卷首": "jgjuanshou", "汲古閣本目錄": "jgmulu",
            "官本目錄": "gbmulu", "官本跋尾": "gbbawei"}
THUMB_WIDTH = 1280
PAGES_RE = re.compile(r'<pages\s+index="([^"]+)"\s+from="?(\d+)"?\s+to="?(\d+)"?')
VOL_RE = re.compile(r"第(\d+)冊")


def api(**kw):
    kw.update(format="json", formatversion="2", maxlag="5")
    data = urllib.parse.urlencode(kw).encode()
    for attempt in range(6):
        time.sleep(0.5)  # 對維基服務器客氣一點
        try:
            req = urllib.request.Request(API, data=data, headers=UA)
            d = json.load(urllib.request.urlopen(req, timeout=60))
            if d.get("error", {}).get("code") != "maxlag":
                return d
            time.sleep(5 * (attempt + 1))
        except urllib.error.HTTPError as e:
            if e.code not in (429, 503):
                raise
            time.sleep(int(e.headers.get("Retry-After") or 5 * (attempt + 1)))
    sys.exit("維基文庫限流，請稍後再試")


def wikitext(titles, progress=None):
    out = {}
    for i in range(0, len(titles), 50):
        d = api(action="query", prop="revisions", rvprop="content", rvslots="main",
                titles="|".join(titles[i:i + 50]))
        if "query" not in d:
            sys.exit(f"讀取失敗：{d}")
        back = {n["to"]: n["from"] for n in d["query"].get("normalized", [])}
        for p in d["query"]["pages"]:
            if "revisions" in p:
                out[back.get(p["title"], p["title"])] = p["revisions"][0]["slots"]["main"]["content"]
        if progress:
            print(f"\r  {progress} {min(i + 50, len(titles))}/{len(titles)}", end="", flush=True)
    return out


def cn2int(s):
    """「七十四」-> 74。"""
    n = 0
    if "十" in s:
        a, _, b = s.partition("十")
        return (CN.index(a) if a else 1) * 10 + (CN.index(b) if b else 0)
    for c in s:
        n = n * 10 + CN.index(c)
    return n


def juan_id(sub):
    if sub in FRONT_ID:
        return FRONT_ID[sub]
    m = re.fullmatch(r"卷([一二三四五六七八九十]+)([上下]?)", sub)
    if m:
        return f"{cn2int(m.group(1)):02d}" + {"上": "a", "下": "b", "": ""}[m.group(2)]
    m = re.fullmatch(r"續漢志第([一二三四五六七八九十]+)", sub)
    if m:
        return f"z{cn2int(m.group(1)):02d}"
    sys.exit(f"不認識的子頁名：{sub}")


def thumb(name):
    """維基共享資源上 PDF 某頁縮略圖的地址（{p} 處填頁號）。路徑前綴是文件名 MD5 的頭兩位。"""
    key = name.replace(" ", "_")
    h = hashlib.md5(key.encode("utf-8")).hexdigest()
    q = urllib.parse.quote(key)
    return (f"https://upload.wikimedia.org/wikipedia/commons/thumb/{h[0]}/{h[:2]}/{q}"
            f"/page{{p}}-{THUMB_WIDTH}px-{q}.jpg")


def main():
    # 1. 主頁目錄
    juan, part = [], ""
    for line in wikitext([WORK])[WORK].splitlines():
        m = re.match(r"^==\s*(.+?)\s*==$", line)
        if m:
            part = m.group(1)
            continue
        m = re.match(r"^\*\s*\[\[/([^|\]]+)\|([^\]]+)\]\]\s*(.*)$", line)
        if m:
            sub, text = m.group(1), m.group(2).strip()
            # 卷名用子頁名（短，便於排版）；鏈接文字若是另一個名字（「後漢書集解述略」），當作篇題
            juan.append({"id": juan_id(sub), "sub": sub, "part": part, "label": sub.replace("續漢志", "志"),
                         "desc": re.sub(r"[\s　]+", " ", m.group(3)).strip()
                                 or ("" if text in (sub, sub.replace("續漢志", "")) else text)})
    print("目錄條目：", len(juan))

    # 2. 各卷子頁 -> 頁碼範圍。底本（慶應本）個別頁掃描有誤，子頁裡單獨嵌入他本的頁，
    #    即 <pages> 的索引名裡沒有「第N冊」的那些；圖和 Page 頁都跟著換。
    subs = wikitext([f"{WORK}/{j['sub']}" for j in juan])
    index, alt = {}, {}
    for j in juan:
        tags = PAGES_RE.findall(subs.get(f"{WORK}/{j['sub']}", ""))
        main_tags = [(name, int(a), int(b)) for name, a, b in tags if VOL_RE.search(name)]
        vols = {int(VOL_RE.search(name).group(1)) for name, _, _ in main_tags}
        if len(vols) != 1:
            sys.exit(f"{j['sub']}：應當恰好在一冊之內，卻找到 {sorted(vols)}")
        j["vol"] = vols.pop()
        index[j["vol"]] = main_tags[0][0]
        j["from"], j["to"] = min(a for _, a, _ in main_tags), max(b for _, _, b in main_tags)
        covered = {p for _, a, b in main_tags for p in range(a, b + 1)}
        for name, a, b in tags:
            if not VOL_RE.search(name):
                for p in range(int(a), int(b) + 1):
                    if p in covered or not j["from"] < p < j["to"]:
                        sys.exit(f"{j['sub']}：他本的第 {p} 頁對不上底本的缺頁")
                    alt.setdefault(str(j["vol"]), {})[str(p)] = {"index": name, "page": p, "thumb": thumb(name)}
        if not j["desc"]:
            sec = re.search(r"^\|section=(.*)$", subs[f"{WORK}/{j['sub']}"], re.M)
            sec = sec.group(1).strip() if sec else ""
            j["desc"] = "" if sec in (j["sub"], j["label"]) else sec

    # 3. 各冊頁數
    pagecount = {}
    d = api(action="query", prop="imageinfo", iiprop="size", titles="|".join("File:" + n for n in index.values()))
    for p in d["query"]["pages"]:
        ii = (p.get("imageinfo") or [{}])[0]
        pagecount[int(VOL_RE.search(p["title"]).group(1))] = ii.get("pagecount")

    # 4. 逐冊讀 Page 頁
    out_pages = SRC / "pages"
    out_pages.mkdir(parents=True, exist_ok=True)
    total, levels = 0, {}
    for vol, name in sorted(index.items()):
        last = pagecount.get(vol) or max(j["to"] for j in juan if j["vol"] == vol) + 4
        title = {p: f"Page:{name}/{p}" for p in range(1, last + 1)}
        for p, a in alt.get(str(vol), {}).items():
            title[int(p)] = f"Page:{a['index']}/{a['page']}"
        got = wikitext(list(title.values()), f"第 {vol:02d} 冊")
        chunks = []
        for p in sorted(title):
            text = got.get(title[p])
            if text is None:
                continue
            text = text.strip("\n")
            if re.search(r"^〔第\d+頁〕$", text, re.M):
                sys.exit(f"第 {vol} 冊第 {p} 頁的正文裡有分頁標記，無法合併")
            q = re.search(r'<pagequality level="(\d)"', text)
            levels[q.group(1) if q else "?"] = levels.get(q.group(1) if q else "?", 0) + 1
            chunks.append(f"〔第{p}頁〕\n{text}\n")
        (out_pages / f"{vol:02d}.wiki").write_text("\n".join(chunks), encoding="utf-8")
        total += len(chunks)
    print("\n各校對等級的頁數：", dict(sorted(levels.items())))

    (SRC / "book.json").write_text(json.dumps({
        "fetched": time.strftime("%Y-%m-%d"), "work": WORK,
        "index": {str(v): n for v, n in sorted(index.items())},
        "files": {str(v): {"pagecount": pagecount.get(v), "thumb": thumb(n)} for v, n in sorted(index.items())},
        "alt": alt, "juan": juan,
    }, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"{len(index)} 冊 {total} 頁 -> {out_pages.relative_to(ROOT)}；{len(juan)} 卷 -> .src/book.json")
    for v, d in alt.items():
        for p, a in d.items():
            print(f"換用他本：第 {v} 冊第 {p} 頁 -> {a['index']} 第 {a['page']} 頁")


if __name__ == "__main__":
    main()
