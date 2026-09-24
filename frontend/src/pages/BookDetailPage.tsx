import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import {
  ApiError,
  exportBook,
  getBook,
  getBookPages,
  getBookToc,
  openBookPage,
  startBookReading,
  type BookDetailDto,
  type BookPageSummaryDto,
  type BookTocDto,
  type ChapterSummaryDto,
} from '../api/client'
import { openChapter } from '../components/BookNextChapter'
import { ListPanel, ListRow, MarkedRowState } from '../components/ListPanel'

/**
 * 目录页。章节列表复用文章库那套 .list-panel —— 三列、已读压暗、
 * 「标了 N 处 →」的位置和行为都和文章库一致，不新造一套交互。
 *
 * 底部是按章导出：闭区间，按章号。**没有「按页导出」这回事**（§0.2）——
 * 页是重排后的视口产物，换个字号就变；这个项目的坐标是 (段序号, 词序号)。
 */
export default function BookDetailPage() {
  const { bookId: bookIdParam } = useParams<{ bookId: string }>()
  const bookId = Number(bookIdParam)
  const navigate = useNavigate()

  const [book, setBook] = useState<BookDetailDto | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [openingId, setOpeningId] = useState<number | null>(null)

  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [markdown, setMarkdown] = useState<string | null>(null)
  const [exportError, setExportError] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)
  const [copied, setCopied] = useState(false)
  const [toc, setToc] = useState<BookTocDto | null>(null)
  const [expandedSection, setExpandedSection] = useState<number | null>(null)
  const [sectionPages, setSectionPages] = useState<Record<number, BookPageSummaryDto[]>>({})

  useEffect(() => {
    let cancelled = false
    setBook(null)
    setError(null)
    getBook(bookId)
      .then((b) => {
        if (!cancelled) setBook(b)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : '加载失败，请刷新重试。')
      })
    return () => {
      cancelled = true
    }
  }, [bookId])

  useEffect(() => {
    if (book?.readingMode !== 'fixed_pages') return
    getBookToc(book.id)
      .then(setToc)
      .catch((err: unknown) => setError(err instanceof ApiError ? err.message : '目录加载失败'))
  }, [book])

  const continueFixedBook = async (articleId?: number) => {
    if (!book || book.readingMode !== 'fixed_pages') return
    setOpeningId(articleId ?? -1)
    try {
      const run = await startBookReading(book.id)
      const opened = await openBookPage(book.id, run.id, articleId ?? run.recommendedArticleId)
      navigate(`/read/${opened.sessionId}?run=${run.id}`)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '打开书页失败，请重试。')
      setOpeningId(null)
    }
  }

  const toggleSection = async (sectionId: number) => {
    if (!book) return
    if (expandedSection === sectionId) {
      setExpandedSection(null)
      return
    }
    setExpandedSection(sectionId)
    if (!sectionPages[sectionId]) {
      try {
        const pages = await getBookPages(book.id, sectionId)
        setSectionPages((current) => ({ ...current, [sectionId]: pages }))
      } catch (err) {
        setError(err instanceof ApiError ? err.message : '书页列表加载失败')
      }
    }
  }

  const openChapterCard = async (chapter: ChapterSummaryDto) => {
    setOpeningId(chapter.id)
    setError(null)
    try {
      navigate(`/read/${await openChapter(chapter.id, chapter.resumeSessionId)}`)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '开始阅读失败，请重试。')
      setOpeningId(null)
    }
  }

  const runExport = async () => {
    setExporting(true)
    setExportError(null)
    setMarkdown(null)
    setCopied(false)
    try {
      const a = Number(from)
      const b = Number(to)
      const range = from && to && a > 0 && b > 0 ? { from: a, to: b } : undefined
      setMarkdown(await exportBook(bookId, range))
    } catch (err) {
      // 范围里一处标记都没有时后端返回 404，不给空壳 Markdown ——
      // 空壳最糟：以为导出成功，粘给 agent 之后才发现没内容
      setExportError(err instanceof ApiError ? err.message : '导出失败，请重试。')
    } finally {
      setExporting(false)
    }
  }

  const copyMarkdown = async () => {
    if (!markdown) return
    await navigator.clipboard.writeText(markdown)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 2000)
  }

  if (error && !book) {
    return (
      <div className="page">
        <p className="error-banner">{error}</p>
        <Link to="/books">← 返回书架</Link>
      </div>
    )
  }

  if (!book) {
    return (
      <div className="page">
        <p className="dim">加载中…</p>
      </div>
    )
  }

  if (book.readingMode === 'fixed_pages') {
    return (
      <div className="page">
        <header className="page-header">
          <div className="page-header__text">
            <Link className="crumb" to="/books">书</Link>
            <h1 className="title">{book.title}</h1>
            <p className="page-header__sub">
              {book.author ?? '佚名'} · 按页读 · 已读 {toc?.finishedPageCount ?? book.finishedPageCount}/
              {toc?.pageCount ?? book.pageCount} 页 · 待回顾{' '}
              {toc?.pendingReviewCount ?? book.pendingReviewCount} 处
            </p>
          </div>
          <div className="book-fixed-actions">
            <Link className="btn-secondary" to={`/books/${book.id}/review`}>
              待回顾与历史批次
            </Link>
            <button className="btn-primary" disabled={openingId !== null} onClick={() => void continueFixedBook()}>
              {openingId !== null ? '打开中…' : '继续阅读'}
            </button>
          </div>
        </header>
        {error && <p className="error-banner">{error}</p>}
        {!toc && !error && <p className="dim">目录加载中…</p>}
        {toc && (
          <div className="book-toc list-panel">
            {toc.sections.map((section, index) => (
              <section className="book-toc-section" key={section.id}>
                {section.partTitle && toc.sections[index - 1]?.partTitle !== section.partTitle && (
                  <h2 className="book-part-title">{section.partTitle}</h2>
                )}
                <button className="book-toc-row" onClick={() => void toggleSection(section.id)}>
                  <span>{section.title}</span>
                  <span className="dim">
                    第 {section.firstPage}–{section.lastPage} 页 · 已读 {section.finishedPageCount}/{section.pageCount}
                  </span>
                </button>
                {expandedSection === section.id && (
                  <div className="book-page-list">
                    {(sectionPages[section.id] ?? []).map((page) => (
                      <button
                        key={page.articleId}
                        className="book-page-row"
                        disabled={openingId !== null}
                        onClick={() => void continueFixedBook(page.articleId)}
                      >
                        第 {page.pageNumber} 页 · {page.wordCount} 词
                        {page.isRead ? ' · 已读' : ''}{page.markCount ? ` · ${page.markCount} 处标记` : ''}
                      </button>
                    ))}
                  </div>
                )}
              </section>
            ))}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="page">
      <header className="page-header">
        <div className="page-header__text">
          <Link className="crumb" to="/books">书</Link>
          <h1 className="title">{book.title}</h1>
          <p className="page-header__sub">
            {book.author ?? '佚名'} · 按章节读 · 已读 {book.finishedChapterCount}/{book.chapterCount} 章 · 共标了{' '}
            {book.totalMarks} 处
          </p>
        </div>
        {book.nextChapter && (
          <button
            className="btn-primary"
            disabled={openingId !== null}
            onClick={() => void openChapterCard(book.chapters.find((c) => c.id === book.nextChapter!.articleId) ?? book.chapters[0])}
          >
            继续读第 {book.nextChapter.orderIndex} 章
          </button>
        )}
      </header>

      {error && <p className="error-banner">{error}</p>}

      <ListPanel columns={['章节', '篇幅', '状态']}>
        {book.chapters.map((c) => (
          <ListRow
            key={c.id}
            tone={c.resumeSessionId !== null ? 'reading' : c.isRead ? 'read' : null}
            title={
              <>
                <span className="chapter-index">第 {c.orderIndex} 章</span>
                {c.title}
              </>
            }
            meta={
              <>
                {c.wordCount} 词
                <span className="list-row__minutes">约 {c.estMinutes} 分钟</span>
              </>
            }
            state={
              openingId === c.id ? (
                <span className="list-row__state is-unread">打开中…</span>
              ) : (
                <MarkedRowState item={c} />
              )
            }
            disabled={openingId !== null}
            onOpen={() => void openChapterCard(c)}
          />
        ))}
      </ListPanel>

      <section className="review book-export">
        <h2>导出标记</h2>
        <p className="dim">按章号选，闭区间。两个都留空 = 整本。只导出标过东西的章。</p>
        <div className="book-export__range">
          <label className="field">
            从第
            <input
              type="number"
              min={1}
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              placeholder="1"
            />
          </label>
          <label className="field">
            到第
            <input
              type="number"
              min={1}
              value={to}
              onChange={(e) => setTo(e.target.value)}
              placeholder={String(book.chapterCount)}
            />
          </label>
          <button className="btn-primary" onClick={runExport} disabled={exporting}>
            {exporting ? '导出中…' : '导出'}
          </button>
        </div>

        {exportError && <p className="error-banner">{exportError}</p>}

        {markdown !== null && (
          <>
            <textarea
              className="export"
              readOnly
              value={markdown}
              onFocus={(e) => e.target.select()}
            />
            <button className="btn-primary" onClick={copyMarkdown}>
              {copied ? '已复制' : '复制到剪贴板'}
            </button>
          </>
        )}
      </section>
    </div>
  )
}
