#!/usr/bin/env python3
"""把 .src/ 裡的維基文庫底稿轉成前端用的靜態數據（site/data/）。

    來源                    提供
    .src/book.json         卷目、各卷的冊次與頁碼範圍、校補起始頁、掃描圖地址、換用他本的頁
    .src/pages/NN.wiki     第 NN 冊各頁的 wikitext（Page: 頁面原樣，以「〔第N頁〕」分頁）
    .src/variants.json     檢索用的繁簡、異體字組

座標是「第 N 冊 PDF 第 M 頁」。只用標準庫：python3 tools/build.py
"""
import json
import re
import shutil
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / ".src"
OUT = ROOT / "site" / "data"
ZIP = ROOT / "site" / "full-site-download.zip"
ZIP_NOTE = """《後漢書集解》在線閱讀站 離線包

在線地址：https://houhanshujijie.daizhige.org/

用法：解壓後在這個目錄裡開一個本地網頁服務器，例如

    python3 -m http.server 8765

然後用瀏覽器打開 http://127.0.0.1:8765/ 。
直接雙擊 index.html 不行，瀏覽器不允許本地文件讀取 data/ 裡的數據。
也可以把整個目錄原樣上傳到任何靜態網站託管。

掃描原圖不在包內，閱讀時從維基共享資源在線載入，需要聯網。

data/j/<卷>.json 是各卷正文，data/s/<卷>.txt 是檢索用的純文本
（每行：頁碼、段序、文本，以製表符分隔），data/toc.json 是卷目。

絕大部分頁面尚未校對，引用前請核對掃描原圖。

版權說明

《後漢書集解》原書（王先謙集解，黃山校補，1915–1924 年刻）已進入公有領域。掃描圖為慶應義塾大學圖書館藏本，載於維基共享資源。

本站文本的底稿由殆知閣整理並上傳至維基文庫，依維基文庫的 CC BY-SA 4.0 協議發佈；維基文庫用戶其後所作的修訂同樣依該協議授權。原書文字屬公有領域的部分，殆知閣不主張任何版權，CC BY-SA 僅及於整理、校訂中可能產生權利的部分。

網站本身（程序與界面設計）版權歸殆知閣所有，依 GNU Affero 通用公共許可證第 3 版或其後版本（AGPL-3.0-or-later）發佈，
許可證全文見包內 LICENSE，源代碼在 https://github.com/daizhige-org/houhanshujijie 。
"""
PAGE_RE = re.compile(r"^〔第(\d+)頁〕$", re.M)
PROOFREAD = 3  # 維基文庫校對等級 ≥3 為已校對/已核對


def make_zip():
    """把整個 site/ 打成一個包，供人下載離線使用。時間戳固定，內容不變則包不變。"""
    site = ZIP.parent
    files = sorted(f for f in site.rglob("*") if f.is_file() and f != ZIP and f.name != ".DS_Store")
    with zipfile.ZipFile(ZIP, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        def add(name, data):
            info = zipfile.ZipInfo("houhanshujijie/" + name, (2026, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            z.writestr(info, data)
        add("README.txt", ZIP_NOTE.encode("utf-8"))
        add("LICENSE", (ROOT / "LICENSE").read_bytes())
        for f in files:
            add(f.relative_to(site).as_posix(), f.read_bytes())
    return len(files), ZIP.stat().st_size


def norm(s):
    """只留文字，去掉標點、括號、空白。"""
    return re.sub(r"[\W_]", "", s)


# ---------------------------------------------------------------- wikitext

class Wikitext:
    """底稿只用到很少幾種標記，逐一處理；遇到不認識的就報錯，免得悄悄漏字。

        {{*|…}}  <small>…</small>   雙行小注
        {{c|…}}  {{right|…}}        居中、靠右的行
        {{t2|…}}  == … ==           標題
        * / ** / ***                目錄的層級
        {{gap|…}}                   空格
        {{分散对齐|字|寬}}            只取字
        {{!|字|拆字}}                罕用字，取第一個參數
        {{nop}}                     段落到本頁結束
        <br />                      換行
    """
    BLOCK_TPL = {"c": "c", "right": "r", "t2": "h"}

    def __init__(self, where):
        self.where = where

    def fail(self, msg, text):
        sys.exit(f"{self.where}：{msg}：{text[:60]!r}")

    def template(self, text, i):
        """text[i:] 以 {{ 開頭；返回 (名, [參數…], 結束位置)。"""
        depth, j, parts, start = 0, i, [], i + 2
        while j < len(text):
            two = text[j:j + 2]
            if two == "{{":
                depth += 1
                j += 2
            elif two == "}}":
                depth -= 1
                if depth == 0:
                    parts.append(text[start:j])
                    return parts[0].strip(), parts[1:], j + 2
                j += 2
            else:
                if text[j] == "|" and depth == 1:
                    parts.append(text[start:j])
                    start = j + 1
                j += 1
        self.fail("模板沒有閉合", text[i:])

    def inline(self, text, note, runs):
        """把一段行內 wikitext 攤平成 [[文字, 是否小注], …]；換行標記記作 "\\n"。"""
        def emit(t, n):
            if not t:
                return
            if runs and runs[-1][1] == n and t != "\n" and runs[-1][0] != "\n":
                runs[-1][0] += t
            else:
                runs.append([t, n])

        i = 0
        for m in re.finditer(r"\{\{|<(/?)(small|br)\s*/?>", text):
            if m.start() < i:
                continue
            emit(text[i:m.start()], note)
            if m.group(0) == "{{":
                name, args, i = self.template(text, m.start())
                if name == "*":
                    self.inline("|".join(args), 1, runs)
                elif name in ("c", "right", "t2", "分散对齐"):
                    self.inline(args[0], note, runs)
                elif name == "gap":
                    emit("　", note)
                elif name == "!":
                    emit(args[0], note)
                elif name != "nop":
                    self.fail(f"不認識的模板 {name}", text[m.start():])
            else:
                i = m.end()
                if m.group(2) == "br":
                    emit("\n", note)
                else:
                    note = 0 if m.group(1) else 1
        emit(text[i:], note)
        if re.search(r"[{}<>]|\[\[|'''", "".join(t for t, _ in runs)):
            self.fail("有沒處理的標記", text)
        return runs

    def lines(self, text):
        """按不在模板內的換行切開。"""
        out, depth, start, i = [], 0, 0, 0
        while i < len(text):
            two = text[i:i + 2]
            if two == "{{":
                depth += 1
                i += 2
            elif two == "}}":
                depth -= 1
                i += 2
            else:
                if text[i] == "\n" and depth == 0:
                    out.append(text[start:i])
                    start = i + 1
                i += 1
        if depth:
            self.fail("模板沒有閉合", text[start:])
        out.append(text[start:])
        return out

    def blocks(self, text):
        """一頁的 wikitext -> ([[類型, runs], …], 是否以 {{nop}} 結束)。

        類型：h 標題、c 居中、r 靠右、p 段落、l1/l2/l3 目錄層級。
        """
        out, para, nop = [], None, False

        def add(kind, src):
            row = []
            for t, n in self.inline(src, 0, []) + [["\n", 0]]:
                if t == "\n":           # <br /> 把一個居中/靠右的塊拆成幾行
                    row = [[t.strip("\n") if kind != "p" else t, n] for t, n in row]
                    if any(norm(t) for t, _ in row):
                        out.append([kind, row])
                    row = []
                else:
                    row.append([t, n])

        for line in self.lines(text):
            s = line.strip()
            if not s:
                para = None
                continue
            nop = False
            m = re.fullmatch(r"\{\{\s*(c|right|t2|nop)\s*(\|.*)?\}\}", s, re.S)
            if m and self.template(s, 0)[2] == len(s):
                para = None
                if m.group(1) == "nop":
                    nop = True
                else:
                    add(self.BLOCK_TPL[m.group(1)], s)
                continue
            m = re.fullmatch(r"(=+)\s*(.*?)\s*=+", s)
            if m:
                para = None
                add("h", m.group(2))
                continue
            m = re.match(r"(\*+)\s*(.*)", s, re.S)
            if m:
                para = None
                add("l" + str(min(len(m.group(1)), 3)), m.group(2))
                continue
            if para is None:
                n = len(out)
                add("p", s)
                para = out[n] if len(out) > n else None
            else:                       # 段內換行：直接相接
                for t, n in self.inline(s, 0, []):
                    if para[1][-1][1] == n:
                        para[1][-1][0] += t
                    else:
                        para[1].append([t, n])
        return out, nop


def load_volume(vol):
    """返回 {頁: {"q": 校對等級, "b": 塊, "nop": 是否以 {{nop}} 結束}}。"""
    text = (SRC / "pages" / f"{vol:02d}.wiki").read_text(encoding="utf-8")
    parts = PAGE_RE.split(text)
    pages = {}
    for k in range(1, len(parts), 2):
        p, raw = int(parts[k]), parts[k + 1]
        q = re.search(r'<pagequality level="(\d)"', raw)
        body = re.sub(r"<noinclude>.*?</noinclude>", "", raw, flags=re.S)
        b, nop = Wikitext(f"第 {vol} 冊第 {p} 頁").blocks(body)
        pages[p] = {"q": int(q.group(1)) if q else None, "b": b, "nop": nop}
    return pages


# ---------------------------------------------------------------- 綱目

CN_NUM = "元一二三四五六七八九十廿卅"
BIO_RE = re.compile(r"^([^。、，：]{2,6})[。、]?字([^。、，：]{1,4})。")
YEAR_RE = re.compile(rf"^((?:[^。、，：{CN_NUM}]{{2,4}})?[{CN_NUM}]{{1,3}}年)(?:[春夏秋冬]|。|[正{CN_NUM}閏]{{1,3}}月)")
LUN_RE = re.compile(r"^(論|贊|讚|序|史臣)曰[。：]?")


def plain(runs, notes=True):
    return "".join(t for t, n in runs if notes or not n)


def make_outline(j, pages, plist):
    """本卷綱目：[層級, 標題, 頁, 該頁第幾塊]。

    一級：卷題、標題、校補；二級：目錄的卷次、紀裡的紀年、傳主（「某某字某某」）、論贊。
    二級是按行文慣例猜的，只為導航方便，難免有漏有誤。
    """
    out, in_jiaobu = [], False
    for p in plist:
        for i, (kind, runs) in enumerate(pages[p]["b"]):
            head = plain(runs, False).strip()
            title = re.sub(r"　+", "　", head).strip("　")
            if kind == "h":
                out.append([1, title, p, i])
            elif kind == "c":
                if "終" in "".join(t for t, n in runs if n) or not title:
                    continue            # 卷末重複的卷題
                in_jiaobu = "校補" in title   # 郡國志五分上下，上卷校補之後還有下卷正文
                out.append([1, title, p, i])
            elif kind == "l1":
                out.append([2, title, p, i])
            elif kind == "p" and not in_jiaobu and not (pages[p]["c"] and i == 0):
                # 校補裡的條目都以所校的正文起頭，不算綱目
                m = LUN_RE.match(head)
                if m:
                    out.append([2, m.group(1) + "曰", p, i])
                    continue
                if j["part"] == "紀":
                    m = YEAR_RE.match(head)
                    if m:
                        out.append([2, m.group(1), p, i])
                        continue
                if j["part"] in ("紀", "列傳"):
                    m = BIO_RE.match(head)
                    if m and "曰" not in m.group(1):
                        out.append([2, m.group(1), p, i])
    return out


# ---------------------------------------------------------------- 主流程

def main():
    book = json.loads((SRC / "book.json").read_text(encoding="utf-8"))
    if OUT.exists():
        shutil.rmtree(OUT)
    (OUT / "j").mkdir(parents=True)
    (OUT / "s").mkdir()

    vols = {int(v): load_volume(int(v)) for v in book["index"]}
    juan = book["juan"]
    toc, covered, levels = [], set(), {}
    for idx, j in enumerate(juan):
        vol, pages = j["vol"], vols[j["vol"]]
        plist = list(range(j["from"], j["to"] + 1))
        prev = None
        for p in plist:
            pg = pages.setdefault(p, {"q": None, "b": [], "nop": False})
            covered.add((vol, p))
            # 與維基文庫的拼接方式一致：下一頁的文字直接接在上一頁的段落後面，除非另起一塊或有 {{nop}}
            pg["c"] = int(bool(prev and prev["b"] and pg["b"] and not prev["nop"]
                               and prev["b"][-1][0] == "p" and pg["b"][0][0] == "p"))
            prev = pg
        outline = make_outline(j, pages, plist)

        out_pages, search_lines, n_chars, n_proof, n_text = [], [], 0, 0, 0
        for p in plist:
            pg = pages[p]
            entry = {"p": p, "b": pg["b"]}
            if pg["q"] is not None:
                entry["q"] = pg["q"]
                levels[pg["q"]] = levels.get(pg["q"], 0) + 1
            if pg["c"]:
                entry["c"] = 1
            if str(p) in book.get("alt", {}).get(str(vol), {}):
                entry["a"] = 1          # 圖和維基文庫頁面換用他本，地址在 toc.json 的 alt 裡
            n_text += bool(pg["b"])
            n_proof += bool(pg["b"]) and (pg["q"] or 0) >= PROOFREAD
            out_pages.append(entry)
            for i, (_, runs) in enumerate(pg["b"]):
                t = plain(runs)
                n_chars += len(norm(t))
                search_lines.append(f"{p}\t{i}\t{t}")

        nav = lambda k: ({"id": juan[k]["id"], "label": juan[k]["label"]} if 0 <= k < len(juan) else None)
        doc = {"id": j["id"], "label": j["label"], "desc": j["desc"], "sub": j["sub"], "vol": vol,
               "from": j["from"], "to": j["to"], "prev": nav(idx - 1), "next": nav(idx + 1),
               "outline": outline, "pages": out_pages}
        (OUT / "j" / f"{j['id']}.json").write_text(
            json.dumps(doc, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        (OUT / "s" / f"{j['id']}.txt").write_text("\n".join(search_lines), encoding="utf-8")
        toc.append({"id": j["id"], "label": j["label"], "desc": j["desc"], "part": j["part"], "vol": vol,
                    "from": j["from"], "to": j["to"], "chars": n_chars, "proof": n_proof, "text": n_text})

    stray = sorted((v, p) for v in vols for p, pg in vols[v].items() if pg["b"] and (v, p) not in covered)

    (OUT / "toc.json").write_text(json.dumps({
        "imported": book["imported"], "work": book["work"], "index": book["index"],
        "files": book["files"], "alt": book.get("alt", {}), "juan": toc,
    }, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    shutil.copy(SRC / "variants.json", OUT / "variants.json")

    size = sum(f.stat().st_size for f in OUT.rglob("*") if f.is_file())
    print(f"{len(toc)} 卷，{sum(t['to'] - t['from'] + 1 for t in toc)} 頁（有字 {sum(t['text'] for t in toc)}），"
          f"{sum(t['chars'] for t in toc):,} 字，輸出 {size / 1e6:.1f} MB -> {OUT.relative_to(ROOT)}")
    print("各校對等級的頁數：", dict(sorted(levels.items())))
    n, zsize = make_zip()
    print(f"離線包：{n} 個文件，{zsize / 1e6:.1f} MB -> {ZIP.relative_to(ROOT)}")
    if stray:
        print(f"未歸入任何卷的有字頁 {len(stray)} 個：", stray[:12], file=sys.stderr)


if __name__ == "__main__":
    main()
