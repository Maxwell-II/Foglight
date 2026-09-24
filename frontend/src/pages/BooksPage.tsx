import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ApiError, openBookPage, startBookReading, type BookSummaryDto } from '../api/client'
import { openChapterById } from '../components/BookNextChapter'
import { useShellData } from '../components/AppShell'
import { ListPanel, ListRow } from '../components/ListPanel'

/**
 * 书架。书是章节的有序编组（work-packets-wave3.md §1.9），章节就是文章，
 * 所以这一页只是另一个**入口**，不是另一套阅读器 —— 列表直接用
 * 文章库那套 .list-panel，不新造一份。
 *
 * 主按钮直接跳「下一章」：order_index 最小的、尚未读完的那一章（§1.11），
 * 不是「最后读的那章 + 1」。
 *
 * 侧栏只有一本书时会直接跳到那本书的目录，这一页平时看不到；
 * 它要撑住的是「有好几本」的情形。
 */

/** 已读 / 总数。两种阅读模式的分母不一样（章 vs 页），在这里抹平。 */
function progressOf(b: BookSummaryDto): { done: number; total: number } {
  return b.readingMode === 'fixed_pages'
    ? { done: b.finishedPageCount, total: b.pageCount }
    : { done: b.finishedChapterCount, total: b.chapterCount }
}

function BookRowState({ book }: { book: BookSummaryDto }) {
  const { done, total } = progressOf(book)
  const finished = book.readingMode === 'fixed_pages' ? total > 0 && done >= total : book.nextChapter === null

  if (finished) {
    return (
      <span className="list-row__state">
        整本读完了
        <Link className="list-row__go" to={`/books/${book.id}`}>
          目录 →
        </Link>
      </span>
    )
  }

  return (
    <span className={`list-row__state${done > 0 ? ' is-reading' : ' is-unread'}`}>
      {done > 0 ? (
        <>
          <span className="lamp lamp--sm" aria-hidden="true" />
          在读 · {total > 0 ? Math.round((done / total) * 100) : 0}%
        </>
      ) : (
        '未读'
      )}
      {/* 压在整行覆盖层之上，否则点它等于点了「继续读」 */}
      <Link className="list-row__go" to={`/books/${book.id}`}>
        目录 →
      </Link>
    </span>
  )
}

export default function BooksPage() {
  const navigate = useNavigate()
  // 书的列表侧栏已经拉过一次（要用它算「继续读」和计数），这里直接取，不再打一遍
  const { books, error: shellError } = useShellData()
  const [error, setError] = useState<string | null>(null)
  const [openingId, setOpeningId] = useState<number | null>(null)

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
      // 整本读完的书没有下一章可跳，这一行只剩「目录」可点
      if (!book.nextChapter) {
        navigate(`/books/${book.id}`)
        return
      }
      navigate(`/read/${await openChapterById(book.nextChapter.articleId)}`)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '打开章节失败，请重试。')
      setOpeningId(null)
    }
  }

  const shown = error ?? shellError

  return (
    <div className="page">
      <header className="page-header">
        <div className="page-header__text">
          <h1 className="title">书</h1>
          <p className="page-header__sub">整本读，按章节推进。</p>
        </div>
      </header>

      {shown && <p className="error-banner">{shown}</p>}

      {books === null && !shown && <p className="dim">加载中…</p>}

      {books && books.length === 0 && (
        <p className="dim">还没有整本的书。用 epub 导入一本，章节会自动编成目录。</p>
      )}

      {books && books.length > 0 && (
        <ListPanel columns={['书', '篇幅', '状态']}>
          {books.map((b) => {
            const { done, total } = progressOf(b)
            const unit = b.readingMode === 'fixed_pages' ? '页' : '章'
            return (
              <ListRow
                key={b.id}
                tone={done > 0 ? (done >= total ? 'read' : 'reading') : null}
                title={b.title}
                sub={
                  <>
                    {b.author ?? '佚名'} · 共标了{' '}
                    {b.readingMode === 'fixed_pages' ? `${b.pendingReviewCount} 处待回顾` : `${b.totalMarks} 处`}
                  </>
                }
                meta={
                  <>
                    {total} {unit}
                    <span className="list-row__minutes">
                      已读 {done}/{total}
                    </span>
                  </>
                }
                state={
                  openingId === b.id ? (
                    <span className="list-row__state is-unread">打开中…</span>
                  ) : (
                    <BookRowState book={b} />
                  )
                }
                disabled={openingId !== null}
                onOpen={() => void startNext(b)}
              />
            )
          })}
        </ListPanel>
      )}
    </div>
  )
}
