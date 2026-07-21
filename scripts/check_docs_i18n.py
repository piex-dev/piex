#!/usr/bin/env python3
"""Validate Chinese-md-only + bilingual HTML workflow for piex.dev.

Source layout:
  docs/<slug>.md              → docs/{zh,en}/docs/<slug>/index.html
  docs/notes/<slug>.md        → docs/{zh,en}/blogs/<slug>/index.html

Rules (docs/site.md + AGENTS.md):
  1. Source markdown is Chinese only at docs/*.md and docs/notes/*.md
  2. No docs/en/**/*.md or docs/zh/**/*.md source files
  3. Every Chinese md has matching zh + en HTML
  4. --staged: when md is staged, both HTML files must also be staged
     (an unstaged HTML newer than the md is treated as verified in sync)
  5. Heuristic language consistency (zh Chinese-heavy, en English-heavy)
  6. Rough structure alignment (h2 counts close)
  7. Footer source links point at the Chinese md path

Usage:
  ./scripts/check-docs-i18n.sh
  ./scripts/check-docs-i18n.sh --staged
  python3 scripts/check_docs_i18n.py [--staged]
"""
from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

RED = "\033[31m"
GRN = "\033[32m"
YLW = "\033[33m"
RST = "\033[0m"

# Ops / non-content markdown at docs root (not bilingual site pages)
SKIP_ROOT_MD = frozenset({"site.md"})


class Counter:
    def __init__(self) -> None:
        self.errors = 0
        self.warnings = 0

    def err(self, msg: str) -> None:
        print(f"{RED}✗{RST} {msg}", file=sys.stderr)
        self.errors += 1

    def warn(self, msg: str) -> None:
        print(f"{YLW}!{RST} {msg}", file=sys.stderr)
        self.warnings += 1

    def ok(self, msg: str) -> None:
        print(f"{GRN}✓{RST} {msg}")


def catalog() -> list[tuple[str, str, Path]]:
    """Return list of (kind, slug, md_path) for Chinese sources."""
    items: list[tuple[str, str, Path]] = []
    docs = ROOT / "docs"
    for p in sorted(docs.glob("*.md")):
        if p.name in SKIP_ROOT_MD:
            continue
        items.append(("docs", p.stem, p))
    notes = docs / "notes"
    if notes.is_dir():
        for p in sorted(notes.glob("*.md")):
            items.append(("blogs", p.stem, p))
    packages = docs / "packages"
    if packages.is_dir():
        for p in sorted(packages.glob("*.md")):
            items.append(("packages", p.stem, p))
    return items


def html_path(lang: str, kind: str, slug: str) -> Path:
    return ROOT / "docs" / lang / kind / slug / "index.html"


def staged_files() -> set[str]:
    try:
        out = subprocess.check_output(
            ["git", "diff", "--cached", "--name-only", "--diff-filter=ACMR"],
            cwd=ROOT,
            text=True,
        )
    except (subprocess.CalledProcessError, FileNotFoundError):
        return set()
    return {line.strip() for line in out.splitlines() if line.strip()}


def rel(p: Path) -> str:
    try:
        return p.relative_to(ROOT).as_posix()
    except ValueError:
        return p.as_posix()


def prose_body(html: str) -> str:
    m = re.search(
        r'<div class="blog-prose">(.*?)</div>\s*(?:<nav class="blog-footer|</article>)',
        html,
        re.S,
    )
    body = m.group(1) if m else html
    body = re.sub(r"<(script|style)[^>]*>.*?</\1>", " ", body, flags=re.S | re.I)
    body = re.sub(r"<[^>]+>", " ", body)
    return body


def lang_ratio(html_text: str) -> tuple[int, int, int, float]:
    body = prose_body(html_text)
    cjk = len(re.findall(r"[\u4e00-\u9fff]", body))
    latin = len(re.findall(r"[A-Za-z]", body))
    total = cjk + latin
    ratio = (cjk / total) if total else 0.0
    return cjk, latin, total, ratio


def is_redirect_stub(html_path: Path) -> bool:
    """A legacy URL stub that only redirects (no content) — skip i18n checks."""
    try:
        html = html_path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return False
    if 'class="blog-prose"' in html:
        return False
    return "location.replace(" in html or "<meta http-equiv=\"refresh\"" in html


def h2_count(html_text: str) -> int:
    return len(re.findall(r"<h2[\s>]", html_text))



def lang_switch_active_ok(html_text: str, page_lang: str) -> bool:
    """Static HTML should mark the page language button active (no FOUC)."""
    m = re.search(
        r'class="lang-switch"[^>]*>\s*'
        r'<button data-lang="en"([^>]*)>\s*EN\s*</button>\s*'
        r'<button data-lang="zh"([^>]*)>\s*中文\s*</button>',
        html_text,
        re.S,
    )
    if not m:
        return False
    en_active = "active" in m.group(1)
    zh_active = "active" in m.group(2)
    if page_lang == "en":
        return en_active and not zh_active
    if page_lang == "zh":
        return zh_active and not en_active
    return False


def source_link_ok(html_text: str, md_rel: str) -> bool:
    """Footer source must point at Chinese md path under docs/ (not docs/zh|en/)."""
    # piex blob must not use language-prefixed source paths
    if re.search(
        r"https://github\.com/piex-dev/piex/blob/main/docs/(?:zh|en)/[^\"\s]+\.md",
        html_text,
    ):
        return False
    # must include the expected Chinese source path
    if md_rel not in html_text:
        return False
    # preferred: explicit blob link
    if f"blob/main/{md_rel}" in html_text:
        return True
    # accept plain path mention as fallback
    return True


def is_stale(html: Path, md: Path) -> bool:
    """HTML older than its Chinese md (5s tolerance) → may be stale."""
    return html.stat().st_mtime + 5 < md.stat().st_mtime


def check_mainjs_symmetry(c: Counter) -> None:
    """docs/assets/main.js en/zh dictionaries must define the same key set.

    Guards against the recurring homepage i18n accidents: a key dropped from
    one language (silent fallback to the inline English text) or a duplicate
    key (dead entry, last one wins).
    """
    print("\n── main.js i18n key symmetry")
    js = ROOT / "docs" / "assets" / "main.js"
    if not js.is_file():
        c.warn(f"{rel(js)} not found — skipping key symmetry check")
        return

    dicts: dict[str, list[str]] = {}
    current: str | None = None
    dict_indent = ""
    for line in js.read_text(encoding="utf-8").splitlines():
        m = re.match(r"^(\s+)(en|zh): \{$", line)
        if m:
            dict_indent, current = m.group(1), m.group(2)
            dicts[current] = []
            continue
        if current and re.match(re.escape(dict_indent) + r"\},?$", line):
            current = None
            continue
        if current:
            km = re.match(r'^\s+"([A-Za-z0-9._]+)":', line)
            if km:
                dicts[current].append(km.group(1))

    if set(dicts) != {"en", "zh"}:
        c.err(f"could not locate both en/zh dictionaries in {rel(js)}")
        return

    bad = False
    for lang in ("en", "zh"):
        keys = dicts[lang]
        dupes = sorted({k for k in keys if keys.count(k) > 1})
        if dupes:
            bad = True
            c.err(f"main.js {lang} dictionary has duplicate keys: {', '.join(dupes)}")
    only_en = sorted(set(dicts["en"]) - set(dicts["zh"]))
    only_zh = sorted(set(dicts["zh"]) - set(dicts["en"]))
    if only_en:
        bad = True
        c.err(f"main.js keys only in en (missing in zh): {', '.join(only_en)}")
    if only_zh:
        bad = True
        c.err(f"main.js keys only in zh (missing in en): {', '.join(only_zh)}")
    if not bad:
        c.ok(f"main.js en/zh dictionaries symmetric ({len(dicts['en'])} keys each)")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--staged",
        action="store_true",
        help="require staged zh+en HTML whenever a Chinese md is staged",
    )
    args = parser.parse_args()
    c = Counter()

    items = catalog()
    if not items:
        c.err("no Chinese source markdown under docs/*.md or docs/notes/")

    # 1. forbid language-prefixed md sources (HTML dirs only under zh/en)
    for lang in ("zh", "en"):
        base = ROOT / "docs" / lang
        if not base.is_dir():
            continue
        for p in sorted(base.rglob("*.md")):
            c.err(
                f"language-prefixed markdown source forbidden: {rel(p)} "
                f"(put Chinese sources at docs/*.md or docs/notes/*.md)"
            )
    if c.errors == 0:
        c.ok("no docs/{zh,en}/**/*.md sources")

    staged = staged_files() if args.staged else set()
    print(f"Checking {len(items)} Chinese source(s)…  staged_mode={args.staged}")

    for kind, slug, md in items:
        md_rel = rel(md)
        zh = html_path("zh", kind, slug)
        en = html_path("en", kind, slug)
        zh_rel, en_rel = rel(zh), rel(en)

        print(f"\n── {md_rel}  ({kind}/{slug})")

        if not zh.is_file():
            c.err(f"missing Chinese HTML: {zh_rel}")
        else:
            c.ok(f"zh HTML: {zh_rel}")
        if not en.is_file():
            c.err(f"missing English HTML: {en_rel}")
        else:
            c.ok(f"en HTML: {en_rel}")

        if args.staged and md_rel in staged:
            if zh_rel in staged:
                c.ok("staged zh HTML with md")
            elif zh.is_file() and not is_stale(zh, md):
                c.warn(
                    f"staged {md_rel} without {zh_rel}, but zh HTML is newer than md"
                    " — treated as in sync"
                )
            else:
                c.err(f"staged {md_rel} but missing staged {zh_rel} — regenerate Chinese HTML")
            if en_rel in staged:
                c.ok("staged en HTML with md")
            elif en.is_file() and not is_stale(en, md):
                c.warn(
                    f"staged {md_rel} without {en_rel}, but en HTML is newer than md"
                    " — treated as in sync"
                )
            else:
                c.err(
                    f"staged {md_rel} but missing staged {en_rel} "
                    "— regenerate English HTML from Chinese md"
                )

        if args.staged:
            if zh_rel in staged and en_rel not in staged:
                c.warn(f"staged {zh_rel} without {en_rel} — bilingual pages should stay in sync")
            if en_rel in staged and zh_rel not in staged:
                c.warn(f"staged {en_rel} without {zh_rel} — bilingual pages should stay in sync")

        zh_text = zh.read_text(encoding="utf-8", errors="replace") if zh.is_file() else ""
        en_text = en.read_text(encoding="utf-8", errors="replace") if en.is_file() else ""

        if not args.staged and zh.is_file() and en.is_file():
            if is_stale(zh, md):
                c.warn(f"{zh_rel} is older than {md_rel} — may be stale")
            if is_stale(en, md):
                c.warn(f"{en_rel} is older than {md_rel} — may be stale")

        if zh.is_file():
            _cjk, _latin, total, ratio = lang_ratio(zh_text)
            if total > 200:
                if ratio < 0.08:
                    c.err(f"Chinese HTML looks English-heavy: {zh_rel} (cjk_ratio={ratio:.1%})")
                else:
                    c.ok(f"zh prose language ok (cjk_ratio={ratio:.1%})")
            if source_link_ok(zh_text, md_rel):
                c.ok(f"zh source link → {md_rel}")
            else:
                c.err(f"zh HTML source link missing/wrong (want {md_rel}): {zh_rel}")

        if en.is_file():
            _cjk, _latin, total, ratio = lang_ratio(en_text)
            if total > 200:
                if ratio > 0.35:
                    c.err(f"English HTML looks Chinese-heavy: {en_rel} (cjk_ratio={ratio:.1%})")
                else:
                    c.ok(f"en prose language ok (cjk_ratio={ratio:.1%})")
            if source_link_ok(en_text, md_rel):
                c.ok(f"en source link → {md_rel}")
            else:
                c.err(f"en HTML source link must point at Chinese md {md_rel}: {en_rel}")

        if zh.is_file() and en.is_file():
            zh_h2, en_h2 = h2_count(zh_text), h2_count(en_text)
            if abs(zh_h2 - en_h2) > 1:
                c.warn(f"h2 count mismatch {zh_rel} ({zh_h2}) vs {en_rel} ({en_h2})")
            else:
                c.ok(f"h2 structure aligned ({zh_h2} vs {en_h2})")

        # 7b. lang-switch active matches page language
        if zh.is_file():
            if lang_switch_active_ok(zh_text, "zh"):
                c.ok("zh lang-switch active = 中文")
            else:
                c.err(f"zh page lang-switch should mark 中文 active: {zh_rel}")
        if en.is_file():
            if lang_switch_active_ok(en_text, "en"):
                c.ok("en lang-switch active = EN")
            else:
                c.err(f"en page lang-switch should mark EN active: {en_rel}")

    # orphan English HTML without Chinese md
    print("\n── orphan scan")
    for kind in ("docs", "blogs", "packages"):
        base = ROOT / "docs" / "en" / kind
        if not base.is_dir():
            continue
        for d in sorted(p for p in base.iterdir() if p.is_dir()):
            slug = d.name
            en_html = d / "index.html"
            # Legacy URL redirect stubs (e.g. /blogs/<pkg>/ → /packages/<pkg>/)
            # carry no content and no md — skip them.
            if en_html.is_file() and is_redirect_stub(en_html):
                continue
            if kind == "blogs":
                md = ROOT / "docs" / "notes" / f"{slug}.md"
            elif kind == "packages":
                md = ROOT / "docs" / "packages" / f"{slug}.md"
            else:
                md = ROOT / "docs" / f"{slug}.md"
            if not md.is_file():
                c.err(
                    f"orphan English HTML without Chinese md: {rel(d)}/ "
                    f"(missing {rel(md)})"
                )

    check_mainjs_symmetry(c)

    print()
    if c.errors:
        print(f"{RED}FAILED{RST}: {c.errors} error(s), {c.warnings} warning(s)")
        print(
            "See docs/site.md — Chinese md at docs/*.md & docs/notes/*.md; "
            "regenerate zh+en HTML together."
        )
        return 1
    print(f"{GRN}PASSED{RST}: docs i18n check ok ({c.warnings} warning(s))")
    return 0


if __name__ == "__main__":
    sys.exit(main())
