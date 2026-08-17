import { useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import {
  ApiError,
  exportSession,
  getArticle,
  getSession,
  type ArticleDetailDto,
  type MarkDto,
  type SessionDetailDto,
} from '../api/client'
import { cmp } from '../lib/pos'

function markPos(m: MarkDto) {
  return { p: m.startParagraphIdx, w: m.startWordIdx }
}

export default function ReviewPage() {
  const { sessionId: sessionIdParam } = useParams<{ sessionId: string }>()
  const sessionId = Number(sessionIdParam)

  const [session, setSession] = useState<SessionDetailDto | null>(null)
  const [article, setArticle] = useState<ArticleDetailDto | null>(null)
  const [markdown, setMarkdown] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let cancelled = false
    setSession(null)
    setArticle(null)
    setMarkdown(null)
    setError(null)

    getSession(sessionId)
      .then(async (s) => {
        if (cancelled) return
        setSession(s)
        const [a, md] = await Promise.all([getArticle(s.articleId), exportSession(sessionId)])
        if (cancelled) return
        setArticle(a)
        setMarkdown(md)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err instanceof ApiError ? err.message : '加载失败，请检查网络后刷新重试。')
      })

    return () => {
      cancelled = true
    }
  }, [sessionId])

  const sortedMarks = useMemo(() => {
    if (!session) return []
    return [...session.marks].sort((a, b) => cmp(markPos(a), markPos(b)))
  }, [session])

  const copyMarkdown = async () => {
    if (!markdown) return
    await navigator.clipboard.writeText(markdown)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 2000)
  }

  if (error) {
    return (
      <div className="wrap">
        <p className="error-banner">{error}</p>
        <Link to="/">返回文章库</Link>
      </div>
    )
  }

  if (!session || !article || markdown === null) {
    return (
      <div className="wrap">
        <p className="dim">加载中…</p>
      </div>
    )
  }

  const unknownCount = session.marks.filter((m) => m.type === 'unknown_word').length
  const unclearCount = session.marks.filter((m) => m.type === 'unclear').length

  return (
    <div className="wrap">
      <Link className="back-link" to="/">
        ← 返回文章库
      </Link>
      <h1 className="title">复盘：{article.title}</h1>
      <div className="meta">
        {article.author ?? '佚名'} · {article.wordCount} 词 · 状态：
        {session.status === 'finished' ? '已完成' : session.status === 'abandoned' ? '已放弃' : '阅读中'}
      </div>

      <Link className="btn-primary" to={`/read/${session.id}`}>
        继续阅读
      </Link>

      <section className="review">
        <h2>本次标记（{session.marks.length}）</h2>
        <p className="dim">
          陌生词 {unknownCount} 处 · 模糊处 {unclearCount} 处
        </p>
        {sortedMarks.length === 0 && <p className="dim">还没有任何标记。</p>}
        <ul className="mark-list">
          {sortedMarks.map((m) => (
            <li key={m.id} className={m.type === 'unknown_word' ? 'li-yellow' : 'li-pink'}>
              <span className="tag">{m.type === 'unknown_word' ? '陌生词' : '模糊处'}</span>
              {m.surfaceText}
            </li>
          ))}
        </ul>

        <h2>导出</h2>
        <textarea className="export" readOnly value={markdown} onFocus={(e) => e.target.select()} />
        <button className="btn-primary" onClick={copyMarkdown}>
          {copied ? '已复制' : '复制到剪贴板'}
        </button>
      </section>
    </div>
  )
}
