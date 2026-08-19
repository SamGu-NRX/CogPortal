"""Mirror the CogWeb textbook: every page's authored source plus every figure.

Sphinx publishes the pre-render source of each page under `_sources/`, so this
fetches markdown/notebook the authors actually wrote rather than a lossy
HTML-to-markdown conversion. The page list comes from `searchindex.js`, which
enumerates the whole site, so this does not need to crawl links.

Polite by construction: one request at a time, a delay between them, a real
User-Agent naming the course, and it skips anything already on disk.
"""
from __future__ import annotations

import json
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

BASE = "https://rsokl.github.io/CogWeb/"
OUT = Path(sys.argv[1] if len(sys.argv) > 1 else "docs/cogweb")
DELAY = 0.4
UA = "CogWorks-BWSI-course-staff-mirror/1.0 (course material capture for benchmark design)"


def get(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=60) as resp:
        return resp.read()


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "media").mkdir(exist_ok=True)

    # searchindex.js is `Search.setIndex({docnames:[...],titles:[...],...})` --
    # a JS object literal with unquoted keys, so json.loads rejects it. The two
    # arrays we want hold only strings, so slice them out directly rather than
    # dragging in a JS parser for a one-shot capture.
    raw = get(BASE + "searchindex.js").decode("utf-8", "replace")

    def js_string_array(key: str) -> list:
        start = raw.index(key + ":[")
        depth, i = 0, start + len(key) + 1
        while True:
            if raw[i] == "[":
                depth += 1
            elif raw[i] == "]":
                depth -= 1
                if depth == 0:
                    break
            i += 1
        return json.loads(raw[start + len(key) + 1: i + 1])

    docnames = js_string_array("docnames")
    try:
        titles = dict(zip(docnames, js_string_array("titles")))
    except (ValueError, json.JSONDecodeError):
        titles = {}
    print("pages in searchindex: {}".format(len(docnames)), flush=True)

    manifest = {"source": BASE, "pages": [], "images": [], "failed": []}
    images: set[str] = set()

    for i, doc in enumerate(docnames, 1):
        got = None
        # Sphinx serves sources with a trailing `.txt` (html_sourcelink_suffix),
        # so the real URL is `<doc>.md.txt`. Keep the authored extension on disk.
        for ext, suffix in ((".md", ".md.txt"), (".ipynb", ".ipynb.txt"),
                            (".rst", ".rst.txt"), (".txt", ".txt")):
            url = "{}_sources/{}{}".format(BASE, doc, suffix)
            dest = OUT / "pages" / (doc + ext)
            if dest.exists():
                got = (dest, ext, dest.read_bytes())
                break
            try:
                body = get(url)
            except urllib.error.HTTPError:
                time.sleep(DELAY / 2)
                continue
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(body)
            time.sleep(DELAY)
            got = (dest, ext, body)
            break
        if got is None:
            manifest["failed"].append(doc)
            print("  [{}/{}] MISS {}".format(i, len(docnames), doc), flush=True)
            continue
        dest, ext, body = got
        text = body.decode("utf-8", "replace")
        for m in re.finditer(r"_images/([A-Za-z0-9_.\-]+)", text):
            images.add(m.group(1))
        for m in re.finditer(r'(?:src|\()\s*=?\s*"?([A-Za-z0-9_.\-/]+\.(?:png|jpg|jpeg|gif|svg))', text):
            name = m.group(1).rsplit("/", 1)[-1]
            images.add(name)
        manifest["pages"].append({"doc": doc, "file": str(dest.relative_to(OUT)),
                                  "title": titles.get(doc, ""), "bytes": len(body)})
        print("  [{}/{}] {}{}  {}b".format(i, len(docnames), doc, ext, len(body)), flush=True)

    print("figures referenced: {}".format(len(images)), flush=True)
    for name in sorted(images):
        dest = OUT / "media" / name
        if dest.exists():
            manifest["images"].append(name)
            continue
        try:
            dest.write_bytes(get("{}_images/{}".format(BASE, name)))
            manifest["images"].append(name)
            time.sleep(DELAY)
        except urllib.error.HTTPError:
            manifest["failed"].append("_images/" + name)

    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print("pages={} images={} failed={}".format(
        len(manifest["pages"]), len(manifest["images"]), len(manifest["failed"])), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
