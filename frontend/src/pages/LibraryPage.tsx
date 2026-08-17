import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ApiError, createSession, listArticles, type ArticleSummaryDto } from '../api/client'

export default function LibraryPage() {
  const navigate = useNavigate()
  const [articles, setArticles] = useState<ArticleSummaryDto[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [startingId, setStartingId] = useState<number | null>(null)

  useEffect(() => {
    let cancelled = false
    listArticles()
      .then((list) => {
        if (!cancelled) setArticles(list)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [])

  const startReading = async (articleId: number) => {
    setStartingId(articleId)
    setError(null)
    try {
      const session = await createSession(articleId)
      navigate(`/read/${session.id}`)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '开始阅读失败，请重试。')
      setStartingId(null)
    }
  }

  return (
    <div className="wrap">
      <div className="library-header">
        <h1 className="title">文章库</h1>
        <Link className="btn-primary" to="/import">
          + 导入文章
        </Link>
      </div>

      {error && <p className="error-banner">{error}</p>}

      {articles === null && !error && <p className="dim">加载中…</p>}

      {articles && articles.length === 0 && (
        <p className="dim">还没有文章，先去导入一篇。</p>
      )}

      {articles && articles.length > 0 && (
        <>
          <p className="dim">共 {articles.length} 篇</p>
          <ul className="article-grid">
            {articles.map((a) => (
              <li key={a.id} className="article-card">
                <button
                  className="article-card__button"
                  disabled={startingId !== null}
                  onClick={() => startReading(a.id)}
                >
                  <h2 className="article-card__title">{a.title}</h2>
                  <div className="article-card__meta">
                    {a.author ?? '佚名'} · {a.wordCount} 词 · 约 {a.estMinutes} 分钟
                  </div>
                  {a.topics.length > 0 && (
                    <div className="article-card__topics">
                      {a.topics.map((t) => (
                        <span className="topic-chip" key={t}>
                          {t}
                        </span>
                      ))}
                    </div>
                  )}
                  {startingId === a.id && <div className="dim">开始阅读中…</div>}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}
