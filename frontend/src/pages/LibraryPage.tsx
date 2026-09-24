import { useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ApiError, createSession, type ArticleLevel, type ArticleSummaryDto } from '../api/client'
import { useShellData } from '../components/AppShell'
import { ListPanel, ListRow, MarkedRowState } from '../components/ListPanel'

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
  const { articles, error: shellError } = useShellData()
  const [error, setError] = useState<string | null>(null)
  const [startingId, setStartingId] = useState<number | null>(null)
  const [level, setLevel] = useState<LevelFilter>(readStoredLevel)

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

  const shown = error ?? shellError

  return (
    <div className="page">
      <header className="page-header">
        <div className="page-header__text">
          <h1 className="title">文章</h1>
          <p className="page-header__sub">按篇幅挑一篇。</p>
        </div>

        {articles && articles.length > 0 && (
          <div className="segmented" role="group" aria-label="篇幅">
            {(['short', 'medium', 'long', 'all'] as const).map((lv) => (
              <button
                key={lv}
                type="button"
                aria-pressed={level === lv}
                onClick={() => selectLevel(lv)}
              >
                {LEVEL_LABELS[lv]}
                <span className="segmented__count">{counts[lv]}</span>
              </button>
            ))}
          </div>
        )}
      </header>

      {shown && <p className="error-banner">{shown}</p>}

      {articles === null && !shown && <p className="dim">加载中…</p>}

      {articles && articles.length === 0 && <p className="dim">还没有文章，先去导入一篇。</p>}

      {filtered && filtered.length === 0 && (
        <p className="dim">
          {level === 'short' ? (
            <>
              还没有短文，<Link to="/import">去导入一篇</Link>
            </>
          ) : (
            '这个档位还没有文章。'
          )}
        </p>
      )}

      {filtered && filtered.length > 0 && (
        <ListPanel columns={['标题', '篇幅', '状态']}>
          {filtered.map((a) => (
            <ListRow
              key={a.id}
              tone={a.resumeSessionId !== null ? 'reading' : a.isRead ? 'read' : null}
              title={a.title}
              sub={
                <>
                  {a.author ?? '佚名'}
                  {a.topics.length > 0 && ` · ${a.topics.join(' · ')}`}
                </>
              }
              meta={
                <>
                  {a.wordCount} 词
                  <span className="list-row__minutes">约 {a.estMinutes} 分钟</span>
                </>
              }
              state={
                startingId === a.id ? (
                  <span className="list-row__state is-unread">打开中…</span>
                ) : (
                  <MarkedRowState item={a} />
                )
              }
              disabled={startingId !== null}
              onOpen={() => startReading(a)}
            />
          ))}
        </ListPanel>
      )}
    </div>
  )
}
