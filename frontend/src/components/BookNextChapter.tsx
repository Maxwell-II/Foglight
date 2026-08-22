import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  createSession,
  getArticle,
  getBook,
  listBooks,
  type BookDetailDto,
  type ChapterSummaryDto,
} from '../api/client'

/**
 * 「下一章」入口。放在复盘页底部：读完 → 复盘 → 下一章。
 *
 * 这是一个刻意的取舍（work-packets-wave3.md §B1）：不做「读完直接跳下一章」，
 * 让复盘挡在中间，因为复盘才是这个产品的主张。用下来觉得挡路再议。
 *
 * ⚠️ 这个组件由书籍包拥有，ReviewPage.tsx 不归书籍包 —— 由 owner 手工接一行进去：
 *
 *     <BookNextChapter articleId={session.articleId} />
 *
 * 传进来的文章不属于任何一本书时（散篇），组件渲染 null，什么都不显示。
 */

/** 开始读某一章：有未完成会话就回到它，否则新建。
 *
 * ⚠️ 这条规则只能有一份实现。每点一次就新建会话的话，上一次标的东西会被孤立在
 * 旧会话里，界面上看起来就是「标记没了」——  Wave 2.5 刚修完的那个 bug。
 * 书籍这边的三个入口（书架 / 目录 / 下一章）全部走这两个函数。
 */
export async function openChapter(
  articleId: number,
  resumeSessionId: number | null,
): Promise<number> {
  if (resumeSessionId !== null) return resumeSessionId
  const session = await createSession(articleId)
  return session.id
}

/** 只知道 articleId（书架上的 nextChapter 不带会话字段）时，先查一次再走同一条规则。 */
export async function openChapterById(articleId: number): Promise<number> {
  const article = await getArticle(articleId)
  return openChapter(articleId, article.resumeSessionId)
}

/** 找出这一章之后该读哪一章。
 *
 * 优先「后面第一个没读完的」；后面全读完了就取紧邻的下一章（重读也算合理动作）；
 * 后面没有章节了，再退回书里最靠前的那个未读章（跳读之后会用到）。
 */
function pickNext(book: BookDetailDto, articleId: number): ChapterSummaryDto | null {
  const index = book.chapters.findIndex((c) => c.id === articleId)
  if (index === -1) return null

  const following = book.chapters.slice(index + 1)
  const nextUnread = following.find((c) => !c.isRead)
  if (nextUnread) return nextUnread
  if (following.length > 0) return following[0]

  const earlierUnread = book.chapters.find((c) => !c.isRead && c.id !== articleId)
  return earlierUnread ?? null
}

export default function BookNextChapter({ articleId }: { articleId: number }) {
  const navigate = useNavigate()
  const [book, setBook] = useState<BookDetailDto | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setBook(null)
    setError(null)

    // ArticleDetailDto 里没有 bookId（client.ts 是冻结契约，不能加），
    // 所以只能反过来找：拉书架，再逐本看章节里有没有它。书的数量是个位数，够用。
    listBooks()
      .then((books) => Promise.all(books.map((b) => getBook(b.id))))
      .then((details) => {
        if (cancelled) return
        setBook(details.find((d) => d.chapters.some((c) => c.id === articleId)) ?? null)
      })
      .catch(() => {
        // 找不到就安静地什么都不显示 —— 这是复盘页的附加入口，不该因为它报错
        if (!cancelled) setBook(null)
      })

    return () => {
      cancelled = true
    }
  }, [articleId])

  if (!book) return null

  const next = pickNext(book, articleId)

  const go = async () => {
    if (!next) return
    setBusy(true)
    setError(null)
    try {
      navigate(`/read/${await openChapter(next.id, next.resumeSessionId)}`)
    } catch {
      setError('打开下一章失败，请重试。')
      setBusy(false)
    }
  }

  return (
    <section className="book-next">
      <div className="dim">
        《{book.title}》· 已读 {book.finishedChapterCount}/{book.chapterCount} 章
      </div>
      {error && <p className="error-banner">{error}</p>}
      {next ? (
        <button className="btn-primary" onClick={go} disabled={busy}>
          {busy ? '打开中…' : `下一章：第 ${next.orderIndex} 章 ${next.title} →`}
        </button>
      ) : (
        <p className="dim">整本读完了。</p>
      )}
    </section>
  )
}
