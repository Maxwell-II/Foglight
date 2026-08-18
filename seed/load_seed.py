"""P10 / W2: read seed/manifest.json, drive the service layer, write articles to the DB.

Reuses the already-verified pipeline instead of reimplementing any of it:
  app.services.epub.parse_epub          -- epub -> Segment list
  app.services.extract.fetch_article    -- URL -> Segment
  app.services.extract.split_by_headings -- long Segment -> Segment list
  app.services.normalize.normalize      -- raw pasted-style text -> cleaned text
  app.services.tokenize.tokenize        -- plain text -> body_paragraphs

Idempotent: rerunning must not create duplicate articles. Dedup key is
(title, source_name) -- the human-readable origin ("Models: Attract Women
Through Honesty", "markmanson.net", "TikTok 短文"), which is stable even if
the epub file moves on disk, a URL gains tracking params, or a text file
gets renamed. source_url is still stored where it exists, but is not part
of the identity.

Console output is ASCII-only on purpose: this machine's terminal is GBK,
and non-ASCII "decoration" characters have crashed scripts here before.
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass, field
from pathlib import Path

from sqlalchemy.orm import Session

from app.models import Article, License, SourceType
from app.services.epub import parse_epub
from app.services.extract import FetchError, fetch_article, split_by_headings
from app.services.normalize import normalize
from app.services.segment import Segment
from app.services.tokenize import tokenize

SEED_DIR = Path(__file__).resolve().parent
REPO_ROOT = SEED_DIR.parent
DEFAULT_MANIFEST = SEED_DIR / "manifest.json"


@dataclass
class ImportStats:
    added: int = 0
    skipped: int = 0
    failed: int = 0
    warnings: list[str] = field(default_factory=list)

    def warn(self, message: str) -> None:
        self.warnings.append(message)


def _est_minutes(word_count: int) -> int:
    return max(1, round(word_count / 200))


def _segment_to_article(
    segment: Segment,
    *,
    author: str,
    source_type: str,
    source_url: str,
    source_name: str,
    license_: str,
    redistributable: bool,
    topics: list[str],
) -> Article:
    # tokenize() is the single frozen implementation (work-packets.md 1.1);
    # body_paragraphs must come from calling it, not from a hand-rolled
    # equivalent that could silently drift.
    body_paragraphs = tokenize("\n\n".join(segment.paragraphs))
    return Article(
        title=segment.title,
        author=author or None,
        source_type=source_type,
        source_url=source_url,
        source_name=source_name,
        license=license_,
        redistributable=redistributable,
        body_paragraphs=body_paragraphs,
        word_count=segment.word_count,
        est_minutes=_est_minutes(segment.word_count),
        topics=list(topics),
        created_by=None,  # curated seed content has no owning user
    )


def _load_existing_keys(session: Session) -> set[tuple[str, str | None]]:
    rows = session.query(Article.title, Article.source_name).all()
    return {(title, source_name) for title, source_name in rows}


def _import_epub_entry(
    entry: dict,
    seen: set[tuple[str, str | None]],
    session: Session,
    stats: ImportStats,
    dry_run: bool,
) -> None:
    path = Path(entry["path"])
    source_name = entry.get("source_name", path.name)

    if not path.exists():
        stats.failed += 1
        stats.warn(f"skip epub source (file not found): {path}")
        return

    try:
        segments = parse_epub(path.read_bytes())
    except Exception as exc:
        stats.failed += 1
        stats.warn(f"skip epub source (parse failed): {path} ({exc})")
        return

    by_title = {seg.title: seg for seg in segments}

    for title in entry.get("segments", []):
        segment = by_title.get(title)
        if segment is None:
            stats.failed += 1
            stats.warn(f"skip epub segment (not found in {source_name}): {title!r}")
            continue

        key = (segment.title, source_name)
        if key in seen:
            stats.skipped += 1
            continue
        seen.add(key)

        article = _segment_to_article(
            segment,
            author=entry.get("author", ""),
            source_type=SourceType.EPUB,
            source_url=str(path),
            source_name=source_name,
            license_=entry.get("license", License.COPYRIGHTED),
            redistributable=bool(entry.get("redistributable", False)),
            topics=entry.get("topics", []),
        )
        stats.added += 1
        if not dry_run:
            session.add(article)


def _import_web_entry(
    entry: dict,
    seen: set[tuple[str, str | None]],
    session: Session,
    stats: ImportStats,
    dry_run: bool,
) -> None:
    # 站点级的人类可读出处；单条 url 可以覆盖它
    entry_source_name = entry.get("source_name", "")

    for url_spec in entry.get("urls", []):
        url = url_spec["url"]
        source_name = url_spec.get("source_name", entry_source_name)
        do_split = bool(url_spec.get("split", False))

        try:
            article_segment = fetch_article(url)
        except FetchError as exc:
            stats.failed += 1
            stats.warn(f"skip url (fetch failed): {url} ({exc})")
            continue

        segments = split_by_headings(article_segment) if do_split else [article_segment]

        for segment in segments:
            key = (segment.title, source_name)
            if key in seen:
                stats.skipped += 1
                continue
            seen.add(key)

            article = _segment_to_article(
                segment,
                author=entry.get("author", ""),
                source_type=SourceType.CURATED,
                source_url=url,
                source_name=source_name,
                license_=entry.get("license", License.COPYRIGHTED),
                redistributable=bool(entry.get("redistributable", False)),
                topics=entry.get("topics", []),
            )
            stats.added += 1
            if not dry_run:
                session.add(article)


def _parse_text_file(path: Path) -> tuple[dict[str, str], str]:
    """Minimal hand-rolled front-matter parser (docs/work-packets-wave2.md
    W2 §2). No PyYAML: pyproject.toml is a contract file, no new deps
    allowed for a seed script.

        ---
        title: The Best Gift a Parent Can Give
        paragraph_mode: blank_line
        topics: parenting, family
        ---

        Many parents spend their whole lives...

    Returns (front_matter_dict, body_text). Raises ValueError if the file
    doesn't open with a "---" line or the front matter is never closed.
    """
    lines = path.read_text(encoding="utf-8").split("\n")
    if not lines or lines[0].strip() != "---":
        raise ValueError("missing front matter (file must start with a '---' line)")
    try:
        closing = lines.index("---", 1)
    except ValueError as exc:
        raise ValueError("front matter never closed with a second '---' line") from exc

    meta: dict[str, str] = {}
    for line in lines[1:closing]:
        if not line.strip() or ":" not in line:
            continue
        key, _, value = line.partition(":")
        meta[key.strip()] = value.strip()

    body = "\n".join(lines[closing + 1 :]).strip("\n")
    return meta, body


def _parse_bool(value: str | None, default: bool) -> bool:
    if value is None:
        return default
    return value.strip().lower() in ("true", "1", "yes")


def _import_text_entry(
    entry: dict,
    seen: set[tuple[str, str | None]],
    session: Session,
    stats: ImportStats,
    dry_run: bool,
) -> None:
    text_dir = Path(entry["dir"])
    if not text_dir.is_absolute():
        # Manifest writes this as "seed/texts" -- relative to the repo root,
        # not to whatever directory the script happens to be run from.
        text_dir = REPO_ROOT / text_dir

    if not text_dir.exists():
        stats.warn(f"skip text source (dir not found): {text_dir}")
        return

    for path in sorted(text_dir.glob("*.md")):
        try:
            meta, body = _parse_text_file(path)
        except ValueError as exc:
            stats.failed += 1
            stats.warn(f"skip text file (bad front matter): {path} ({exc})")
            continue

        title = meta.get("title", "").strip()
        if not title:
            stats.failed += 1
            stats.warn(f"skip text file (missing title): {path}")
            continue

        if not body.strip():
            stats.failed += 1
            stats.warn(f"skip text file (empty body): {path}")
            continue

        source_name = meta.get("source_name", entry.get("source_name", ""))
        key = (title, source_name)
        if key in seen:
            stats.skipped += 1
            continue
        seen.add(key)

        # Every field falls back to the manifest entry's value when the
        # per-file front matter doesn't declare it (work-packets-wave2.md
        # W2 §2: "缺省字段回退到 manifest 里的条目级取值").
        paragraph_mode = meta.get("paragraph_mode", "blank_line")
        topics_raw = meta.get("topics")
        topics = (
            [t.strip() for t in topics_raw.split(",") if t.strip()]
            if topics_raw
            else list(entry.get("topics", []))
        )

        # tokenize() 是冻结的唯一实现；normalize() 是它的上游清洗步骤，
        # 不许自己再写一份（work-packets-wave2.md W2 §2 第 3 点）。
        body_paragraphs = tokenize(normalize(body, paragraph_mode=paragraph_mode))
        word_count = sum(len(p) for p in body_paragraphs)

        article = Article(
            title=title,
            author=meta.get("author", entry.get("author", "")) or None,
            source_type=SourceType.CURATED,
            source_url=None,
            source_name=source_name,
            license=meta.get("license", entry.get("license", License.COPYRIGHTED)),
            redistributable=_parse_bool(
                meta.get("redistributable"), bool(entry.get("redistributable", False))
            ),
            body_paragraphs=body_paragraphs,
            word_count=word_count,
            est_minutes=_est_minutes(word_count),
            topics=topics,
            created_by=None,
        )
        stats.added += 1
        if not dry_run:
            session.add(article)


def load_manifest(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def run(manifest_path: Path, session: Session, dry_run: bool = False) -> ImportStats:
    """Core import logic. Takes an already-open Session so callers (including
    tests) control exactly which database it touches."""
    manifest = load_manifest(manifest_path)
    stats = ImportStats()
    seen = _load_existing_keys(session)

    for entry in manifest.get("epub_sources", []):
        _import_epub_entry(entry, seen, session, stats, dry_run)

    for entry in manifest.get("web_sources", []):
        _import_web_entry(entry, seen, session, stats, dry_run)

    for entry in manifest.get("text_sources", []):
        _import_text_entry(entry, seen, session, stats, dry_run)

    if not dry_run:
        session.commit()

    return stats


def _print_report(stats: ImportStats, dry_run: bool) -> None:
    prefix = "[DRY RUN] " if dry_run else ""
    for warning in stats.warnings:
        print(f"{prefix}WARN: {warning}")
    print(f"{prefix}added={stats.added} skipped={stats.skipped} failed={stats.failed}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Import seed articles from a manifest file.")
    parser.add_argument(
        "--manifest",
        type=Path,
        default=DEFAULT_MANIFEST,
        help="Path to the manifest JSON file (default: seed/manifest.json).",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print what would be imported without writing to the database.",
    )
    args = parser.parse_args(argv)

    from app.db import SessionLocal  # deferred: only the real CLI path touches the real DB

    session = SessionLocal()
    try:
        stats = run(args.manifest, session, dry_run=args.dry_run)
    finally:
        session.close()

    _print_report(stats, args.dry_run)
    return 1 if stats.failed else 0


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="backslashreplace")
        sys.stderr.reconfigure(encoding="utf-8", errors="backslashreplace")
    raise SystemExit(main())
