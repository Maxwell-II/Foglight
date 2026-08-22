import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import {
  ApiError,
  exportBook,
  getBook,
  type BookDetailDto,
  type ChapterSummaryDto,
} from '../api/client'
import { openChapter } from '../components/BookNextChapter'

/**
 * 目录页。章节卡片复用首页那套 .article-card —— 已读角标、「上次标了 N 处 →」
 * 的位置和行为都和首页一致，不新造一套交互。
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
      <div className="wrap">
        <p className="error-banner">{error}</p>
        <Link to="/books">← 返回书架</Link>
      </div>
    )
  }

  if (!book) {
    return (
      <div className="wrap">
        <p className="dim">加载中…</p>
      </div>
    )
  }

  return (
    <div className="wrap">
      <Link className="back-link" to="/books">
        ← 返回书架
      </Link>
      <h1 className="title">{book.title}</h1>
      <div className="meta">
        {book.author ?? '佚名'} · 已读 {book.finishedChapterCount}/{book.chapterCount} 章 · 共标了{' '}
        {book.totalMarks} 处
      </div>

      {error && <p className="error-banner">{error}</p>}

      <ul className="article-grid">
        {book.chapters.map((c) => (
          <li key={c.id} className="article-card">
            <button
              className={`article-card__button${c.isRead ? ' is-read' : ''}`}
              disabled={openingId !== null}
              onClick={() => openChapterCard(c)}
            >
              <h2 className="article-card__title">
                <span className="chapter-index">第 {c.orderIndex} 章</span>
                {c.title}
              </h2>
              <div className="article-card__meta">
                {c.isRead && <span className="read-badge">已读</span>}
                {c.resumeSessionId !== null && <span className="read-badge">读到一半</span>}
                {c.wordCount} 词 · 约 {c.estMinutes} 分钟
              </div>
              {openingId === c.id && <div className="dim">开始阅读中…</div>}
            </button>
            {/* 必须放在 button 外面：HTML 不允许 button 里再嵌可交互元素 */}
            {c.lastMarksSessionId !== null && (
              <Link className="article-card__marks" to={`/review/${c.lastMarksSessionId}`}>
                上次标了 {c.lastMarksCount} 处 →
              </Link>
            )}
          </li>
        ))}
      </ul>

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
