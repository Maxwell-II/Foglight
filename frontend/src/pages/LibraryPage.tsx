import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import {
  ApiError,
  createSession,
  listArticles,
  type ArticleLevel,
  type ArticleSummaryDto,
} from '../api/client'

const LEVEL_STORAGE_KEY = 'reading.libraryLevel'

type LevelFilter = ArticleLevel | 'all'

const LEVEL_LABELS: Record<LevelFilter, string> = {
  short: '短文',
  medium: '中等',
  long: '长文',
  all: '全部',
}

function readStoredLevel(): LevelFilter {
  try {
    const stored = localStorage.getItem(LEVEL_STORAGE_KEY)
    if (stored === 'short' || stored === 'medium' || stored === 'long' || stored === 'all') {
      return stored
    }
  } catch {
    // localStorage 不可用（隐私模式等）时忽略，走默认值
  }
  return 'short'
}

export default function LibraryPage() {
  const navigate = useNavigate()
  const [articles, setArticles] = useState<ArticleSummaryDto[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [startingId, setStartingId] = useState<number | null>(null)
  const [level, setLevel] = useState<LevelFilter>(readStoredLevel)

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

  const selectLevel = (next: LevelFilter) => {
    setLevel(next)
    try {
      localStorage.setItem(LEVEL_STORAGE_KEY, next)
    } catch {
      // 存不进去就算了，不影响本次会话内的筛选
    }
  }

  const counts = useMemo(() => {
    const base: Record<LevelFilter, number> = { short: 0, medium: 0, long: 0, all: 0 }
    for (const a of articles ?? []) {
      base[a.level] += 1
      base.all += 1
    }
    return base
  }, [articles])

  const filtered = useMemo(() => {
    if (!articles) return null
    return level === 'all' ? articles : articles.filter((a) => a.level === level)
  }, [articles, level])

  const startReading = async (article: ArticleSummaryDto) => {
    // 有未完成的会话就回到它。不复用的话每点一次就开一个空会话，
    // 上一次标的东西被孤立在旧会话里，界面上看起来就是「标记没了」。
    if (article.resumeSessionId !== null) {
      navigate(`/read/${article.resumeSessionId}`)
      return
    }

    setStartingId(article.id)
    setError(null)
    try {
      const session = await createSession(article.id)
      navigate(`/read/${session.id}`)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '开始阅读失败，请重试。')
      setStartingId(null)
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
        <h1 className="title">文章库</h1>
        <div className="library-header__actions">
          {/* 书是另一个入口，不是另一套阅读器：首页保持短文默认不变（§0.2） */}
          <Link className="back-link" to="/books">
            书架 →
          </Link>
          <Link className="btn-primary" to="/import">
            + 导入文章
          </Link>
        </div>
      </div>

      {error && <p className="error-banner">{error}</p>}

      {articles === null && !error && <p className="dim">加载中…</p>}

      {articles && articles.length === 0 && (
        <p className="dim">还没有文章，先去导入一篇。</p>
      )}

      {articles && articles.length > 0 && (
        <>
          <div className="level-tabs">
            {(['short', 'medium', 'long', 'all'] as const).map((lv) => (
              <button
                key={lv}
                type="button"
                className={`level-tab${level === lv ? ' is-active' : ''}`}
                onClick={() => selectLevel(lv)}
              >
                {LEVEL_LABELS[lv]} ({counts[lv]})
              </button>
            ))}
          </div>

          {filtered && filtered.length === 0 && level === 'short' && (
            <p className="dim">
              还没有短文，<Link to="/import">去导入一篇</Link>
            </p>
          )}
          {filtered && filtered.length === 0 && level !== 'short' && (
            <p className="dim">这个档位还没有文章。</p>
          )}

          {filtered && filtered.length > 0 && (
            <ul className="article-grid">
              {filtered.map((a) => (
                <li key={a.id} className="article-card">
                  <button
                    className={`article-card__button${a.isRead ? ' is-read' : ''}`}
                    disabled={startingId !== null}
                    onClick={() => startReading(a)}
                  >
                    <h2 className="article-card__title">{a.title}</h2>
                    <div className="article-card__meta">
                      {a.isRead && <span className="read-badge">已读</span>}
                      {a.resumeSessionId !== null && <span className="read-badge">读到一半</span>}
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
                  {/* 必须放在 button 外面：HTML 不允许 button 里再嵌可交互元素 */}
                  {a.lastMarksSessionId !== null && (
                    <Link className="article-card__marks" to={`/review/${a.lastMarksSessionId}`}>
                      上次标了 {a.lastMarksCount} 处 →
                    </Link>
                  )}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  )
}
