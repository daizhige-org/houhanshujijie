#!/usr/bin/env python3
"""把本機的維基文庫底稿導入 .src/（底稿有更新後重新運行，再運行 tools/build.py）。

底稿在整理《後漢書集解》上傳維基文庫的工作目錄裡（默認 ../jinshujiaozhu）：

    pages_hhs/KEIO-<號>/<頁>.wiki      每頁一個文件，即 Page: 頁面的 wikitext
    plans/hhs_juan.json               正文九十卷、續志三十卷的冊次與頁碼範圍（含校補起始頁）
    plans/hhs_keio_pdfs.json          各冊 PDF 的頁數
    pages_hhs/_hold/KEIO-<號>_<頁>.wiki  慶應本掃描有誤、換用他本的頁的文字（見下面的 ALT）
    wikisource/後漢書集解.wiki          主頁目錄：分部、各卷子頁名與篇題
    wikisource/hhs_<子頁>.wiki         卷首各篇的 <pages from= to=>
    commons/KEIO-…第NN冊….wiki         各冊 PDF 在共享資源的描述頁（只用文件名）

輸出：

    .src/pages/NN.wiki   每冊一個文件，以「〔第N頁〕」分頁，其後是該頁 wikitext 原樣
    .src/book.json       卷目、頁碼範圍、索引名、掃描圖地址

只用標準庫，不聯網：python3 tools/import_drafts.py [底稿目錄]
"""
import hashlib
import json
import re
import sys
import time
import urllib.parse
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / ".src"
WORK = "後漢書集解"
CN = "〇一二三四五六七八九"
FRONT_ID = {"序": "xu", "述略": "shulue", "汲古閣本卷首": "jgjuanshou", "汲古閣本目錄": "jgmulu",
            "官本目錄": "gbmulu", "官本跋尾": "gbbawei"}
THUMB_WIDTH = 1280
# 慶應本個別頁掃描有誤（拍重、缺拍），維基文庫在索引頁的 <pagelist> 裡把這一頁換成他本的 Page 頁，
# 卷的子頁也單獨嵌入它。這裡照樣處理：(冊, 頁) -> (他本的索引名, 頁)。文字在 _hold/ 裡。
#   Index:KEIO-10811245390 …第10冊….pdf：<pagelist to=52 /> [[Page:SSID-13358080 後漢書集解 卷30-34.pdf/52|52（他本）]] <pagelist from=53 />
ALT = {(10, 52): ("SSID-13358080 後漢書集解 卷30-34.pdf", 52)}


def cn(n):
    if n < 10:
        return CN[n]
    if n < 20:
        return "十" + (CN[n - 10] if n > 10 else "")
    return CN[n // 10] + "十" + (CN[n % 10] if n % 10 else "")


def thumb(name):
    """維基共享資源上 PDF 某頁縮略圖的地址（{p} 處填頁號）。路徑前綴是文件名 MD5 的頭兩位。"""
    key = name.replace(" ", "_")
    h = hashlib.md5(key.encode("utf-8")).hexdigest()
    q = urllib.parse.quote(key)
    return (f"https://upload.wikimedia.org/wikipedia/commons/thumb/{h[0]}/{h[:2]}/{q}"
            f"/page{{p}}-{THUMB_WIDTH}px-{q}.jpg")


def front(draft, sub):
    """卷首各篇不在 hhs_juan.json 裡，頁碼範圍和篇題取自子頁底稿的 <pages> 與 section。"""
    w = (draft / "wikisource" / f"hhs_{sub}.wiki").read_text(encoding="utf-8")
    m = re.search(r'<pages index="[^"]*第(\d+)冊[^"]*"\s+from=(\d+)\s+to=(\d+)', w)
    sec = re.search(r"^\|section=(.*)$", w, re.M)
    sec = sec.group(1).strip() if sec else ""
    return {"id": FRONT_ID[sub], "vol": int(m.group(1)), "from": int(m.group(2)), "to": int(m.group(3)),
            "jiaobu": [], "desc": "" if sec == sub else sec}


def main():
    draft = Path(sys.argv[1] if len(sys.argv) > 1 else ROOT.parent / "jinshujiaozhu").resolve()
    if not (draft / "pages_hhs").is_dir():
        sys.exit(f"沒有找到底稿目錄：{draft}/pages_hhs")

    # 1. 各冊索引名（= 共享資源上的 PDF 文件名）
    index = {}
    for f in (draft / "commons").glob("KEIO-* 後漢書集解 第*冊*.wiki"):
        index[int(re.search(r"第(\d+)冊", f.name).group(1))] = f.stem + ".pdf"
    pagecount = {x["vol"]: x["pages"] for x in
                 json.loads((draft / "plans" / "hhs_keio_pdfs.json").read_text(encoding="utf-8"))}

    # 2. 逐冊合併 Page 頁
    out_pages = SRC / "pages"
    out_pages.mkdir(parents=True, exist_ok=True)
    have, total, held = {}, 0, []
    for vol, name in sorted(index.items()):
        d = draft / "pages_hhs" / name.split(" ", 1)[0]
        files = {int(f.stem): f for f in d.glob("*.wiki")}
        # 換用他本的頁，文字暫存在 _hold：補進來讓正文連貫
        for f in (draft / "pages_hhs" / "_hold").glob(d.name + "_*.wiki"):
            n = int(f.stem.rsplit("_", 1)[1])
            if n not in files:
                files[n] = f
                held.append((vol, n))
        nums = sorted(files)
        chunks = []
        for n in nums:
            text = files[n].read_text(encoding="utf-8").strip("\n")
            if re.search(r"^〔第\d+頁〕$", text, re.M):
                sys.exit(f"第 {vol} 冊第 {n} 頁的正文裡有分頁標記，無法合併")
            chunks.append(f"〔第{n}頁〕\n{text}\n")
        (out_pages / f"{vol:02d}.wiki").write_text("\n".join(chunks), encoding="utf-8")
        have[vol] = set(nums)
        total += len(nums)

    # 3. 卷目：主頁目錄給出分部、子頁名、篇題；頁碼範圍來自 hhs_juan.json 和卷首各篇的子頁
    plan = json.loads((draft / "plans" / "hhs_juan.json").read_text(encoding="utf-8"))
    rng = {}
    for r in plan["main"]:
        m = re.match(r"(\d+)([上下]?)", r["juan"])
        rng["卷" + cn(int(m.group(1))) + m.group(2)] = (
            f"{int(m.group(1)):02d}" + {"上": "a", "下": "b", "": ""}[m.group(2)], r)
    for r in plan["zhi"]:
        rng["續漢志第" + cn(int(r["juan"]))] = (f"z{int(r['juan']):02d}", r)

    juan, part = [], ""
    main_page = (draft / "wikisource" / f"{WORK}.wiki").read_text(encoding="utf-8")
    for line in main_page.splitlines():
        m = re.match(r"^==\s*(.+?)\s*==$", line)
        if m:
            part = m.group(1)
            continue
        m = re.match(r"^\*\s*\[\[/([^|\]]+)\|([^\]]+)\]\]\s*(.*)$", line)
        if not m:
            continue
        sub, label, desc = m.group(1), m.group(2).strip(), re.sub(r"[\s　]+", " ", m.group(3)).strip()
        j = {"sub": sub, "part": part, "desc": desc}
        if sub in rng:
            j["id"], r = rng[sub]
            j.update(vol=r["vol"], **{"from": r["start"], "to": r["end"]})
            # 校補起始頁；郡國志五分上下，各有校補
            j["jiaobu"] = [r[k] for k in ("jiaobu", "jiaobu2") if r.get(k)]
            j["label"] = sub.replace("續漢志", "志")
        else:
            j.update(front(draft, sub), label=label)
            j["desc"] = desc or j["desc"]
        juan.append(j)
    # 底稿的主頁目錄若還沒有「卷首」一節，就按卷首各篇子頁的頁碼順序補在最前面
    extra = [dict(front(draft, sub), sub=sub, part="卷首", label=sub)
             for sub in FRONT_ID if not any(j["sub"] == sub for j in juan)
             and (draft / "wikisource" / f"hhs_{sub}.wiki").exists()]
    juan = sorted(extra, key=lambda j: j["from"]) + juan

    missing = [(j["sub"], p) for j in juan for p in range(j["from"], j["to"] + 1) if p not in have[j["vol"]]]
    covered = {(j["vol"], p) for j in juan for p in range(j["from"], j["to"] + 1)}
    stray = sorted((v, p) for v in have for p in have[v] if (v, p) not in covered)

    # 換用他本的頁：圖和維基文庫的 Page 頁都指向另一個文件
    alt = {}
    for (v, p), (name, n) in ALT.items():
        if (v, p) not in held:
            sys.exit(f"第 {v} 冊第 {p} 頁要換用他本，但 _hold 裡沒有它的文字")
        alt.setdefault(str(v), {})[str(p)] = {"index": name, "page": n, "thumb": thumb(name)}
    for v, p in held:
        if (v, p) not in ALT:
            sys.exit(f"_hold 裡有第 {v} 冊第 {p} 頁，但 ALT 沒有說明它換用哪個文件")

    (SRC / "book.json").write_text(json.dumps({
        "imported": time.strftime("%Y-%m-%d"), "work": WORK,
        "index": {str(v): n for v, n in sorted(index.items())},
        "files": {str(v): {"pagecount": pagecount.get(v), "thumb": thumb(n)} for v, n in sorted(index.items())},
        "alt": alt, "juan": juan,
    }, ensure_ascii=False, indent=1), encoding="utf-8")

    print(f"{len(index)} 冊 {total} 頁 -> {out_pages.relative_to(ROOT)}；{len(juan)} 卷 -> .src/book.json")
    if held:
        print("換用他本的頁：", [f"第 {v} 冊第 {p} 頁 -> {ALT[v, p][0]} 第 {ALT[v, p][1]} 頁" for v, p in held])
    if missing:
        print(f"卷內沒有底稿的頁 {len(missing)} 個（當作空白頁）：", missing[:20])
    if stray:
        print(f"不屬於任何卷的底稿頁 {len(stray)} 個：", stray[:20])


if __name__ == "__main__":
    main()
