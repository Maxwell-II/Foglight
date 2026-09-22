import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ApiError, listBooks, openBookPage, startBookReading, type BookSummaryDto } from '../api/client'
import { openChapterById } from '../components/BookNextChapter'

/**
 * 书架。书是章节的有序编组（work-packets-wave3.md §1.9），章节就是文章，
 * 所以这一页只是另一个**入口**，不是另一套阅读器 —— 样式和交互直接复用
 * 首页那套 .article-card，不新造一份。
 *
 * 主按钮直接跳「下一章」：order_index 最小的、尚未读完的那一章（§1.11），
 * 不是「最后读的那章 + 1」。
 */
export default function BooksPage() {
  const navigate = useNavigate()
  const [books, setBooks] = useState<BookSummaryDto[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [openingId, setOpeningId] = useState<number | null>(null)

  useEffect(() => {
    let cancelled = false
    listBooks()
      .then((list) => {
        if (!cancelled) setBooks(list)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [])

  const startNext = async (book: BookSummaryDto) => {
    setOpeningId(book.id)
    setError(null)
    try {
      if (book.readingMode === 'fixed_pages') {
        const run = await startBookReading(book.id)
        const opened = await openBookPage(book.id, run.id, run.recommendedArticleId)
        navigate(`/read/${opened.sessionId}?run=${run.id}`)
        return
      }
      if (!book.nextChapter) return
      navigate(`/read/${await openChapterById(book.nextChapter.articleId)}`)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '打开章节失败，请重试。')
      setOpeningId(null)
    }
  }

  return (
    <div className="wrap">
      <div className="site-header">
        <span className="brand">
          Foglight <span className="brand__sub">雾灯</span>
        </span>
      </div>

      <div className="library-header">
        <h1 className="title">书架</h1>
        <Link className="back-link" to="/">
          文章库 →
        </Link>
      </div>

      {error && <p className="error-banner">{error}</p>}

      {books === null && !error && <p className="dim">加载中…</p>}

      {books && books.length === 0 && (
        <p className="dim">还没有整本的书。用 epub 导入一本，章节会自动编成目录。</p>
      )}

      {books && books.length > 0 && (
        <ul className="article-grid">
          {books.map((b) => {
            const done = b.readingMode === 'legacy_chapters' && b.nextChapter === null
            return (
              <li key={b.id} className="article-card">
                <button
                  className={`article-card__button${done ? ' is-read' : ''}`}
                  disabled={done || openingId !== null}
                  onClick={() => startNext(b)}
                >
                  <h2 className="article-card__title">{b.title}</h2>
                  <div className="article-card__meta">
                    {b.author ?? '佚名'} · {b.readingMode === 'fixed_pages'
                      ? `已读 ${b.finishedPageCount}/${b.pageCount} 页 · 待回顾 ${b.pendingReviewCount} 处`
                      : `已读 ${b.finishedChapterCount}/${b.chapterCount} 章 · 共标了 ${b.totalMarks} 处`}
                  </div>
                  <div className="book-card__next">
                    {done
                      ? '整本读完了'
                      : b.readingMode === 'fixed_pages'
                        ? '继续阅读 →'
                        : `继续读：第 ${b.nextChapter!.orderIndex} 章 ${b.nextChapter!.title} →`}
                  </div>
                  {openingId === b.id && <div className="dim">打开中…</div>}
                </button>
                {/* 必须放在 button 外面：HTML 不允许 button 里再嵌可交互元素 */}
                <Link className="article-card__marks" to={`/books/${b.id}`}>
                  目录（{b.readingMode === 'fixed_pages' ? `${b.pageCount} 页` : `${b.chapterCount} 章`}）→
                </Link>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
