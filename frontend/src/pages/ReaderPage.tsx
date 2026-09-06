import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import {
  ApiError,
  createMark,
  deleteMark,
  getArticle,
  getSession,
  finishBookReading,
  openBookPage,
  toArticle,
  toMark,
  toMarkCreatePayload,
  updateSession,
  type ArticleDetailDto,
  type SessionDetailDto,
} from '../api/client'
import { useMarking } from '../hooks/useMarking'
import { ArticleBody } from '../components/reader/ArticleBody'
import { PenToolbar } from '../components/reader/PenToolbar'
import { marksAt } from '../lib/pos'
import type { Mark, Pos } from '../types'

const SCROLL_DEBOUNCE_MS = 800
const TOAST_MS = 4000

export default function ReaderPage() {
  const { sessionId: sessionIdParam } = useParams<{ sessionId: string }>()
  const sessionId = Number(sessionIdParam)
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const bookRunId = Number(searchParams.get('run')) || undefined

  const [session, setSession] = useState<SessionDetailDto | null>(null)
  const [articleDto, setArticleDto] = useState<ArticleDetailDto | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  // 已经落库的标记（会话详情带回来的），和 useMarking 本次会话内新建的标记分开管理——
  // useMarking 没有暴露"注入初始标记"的接口（也不该有，那不是它的职责），
  // 所以已保存的走这份独立状态，渲染时和 useMarking 的 marks 合并。
  const [savedMarks, setSavedMarks] = useState<Mark[]>([])
  const [finishing, setFinishing] = useState(false)
  const pendingWrites = useRef<Set<Promise<unknown>>>(new Set())
  const trackWrite = useCallback((request: Promise<unknown>) => {
    pendingWrites.current.add(request)
    void request.finally(() => pendingWrites.current.delete(request))
  }, [])
  const flushWrites = useCallback(async () => {
    while (pendingWrites.current.size > 0) {
      await Promise.allSettled([...pendingWrites.current])
    }
  }, [])

  const [toast, setToast] = useState<{ text: string; kind: 'error' | 'info' } | null>(null)
  const toastTimer = useRef<number | undefined>(undefined)
  const showToast = useCallback((text: string, kind: 'error' | 'info', autoHideMs = TOAST_MS) => {
    setToast({ text, kind })
    window.clearTimeout(toastTimer.current)
    if (autoHideMs > 0) {
      toastTimer.current = window.setTimeout(() => setToast(null), autoHideMs)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    setSession(null)
    setArticleDto(null)
    setSavedMarks([])
    setLoadError(null)

    getSession(sessionId)
      .then(async (s) => {
        if (cancelled) return
        setSession(s)
        setSavedMarks(s.marks.map(toMark))
        const a = await getArticle(s.articleId)
        if (cancelled) return
        setArticleDto(a)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setLoadError(err instanceof ApiError ? err.message : '加载失败，请检查网络后刷新重试。')
      })

    return () => {
      cancelled = true
    }
  }, [sessionId])

  const article = useMemo(() => (articleDto ? toArticle(articleDto) : null), [articleDto])

  // useMarking 必须无条件调用（React hooks 规则），文章还没加载完时给个空数组占位，
  // 此时 ArticleBody 还没渲染，不会有任何点击发生。
  const marking = useMarking(article?.paragraphs ?? [])

  const allMarks = useMemo(() => [...savedMarks, ...marking.marks], [savedMarks, marking.marks])

  const counts = useMemo(
    () => ({
      unknown: allMarks.filter((m) => m.type === 'unknown_word').length,
      unclear: allMarks.filter((m) => m.type === 'unclear').length,
    }),
    [allMarks],
  )

  // ---------- 已保存标记的移除：自己处理，不走 hook.clickWord ----------
  // hook.clickWord 的"点已标记处=取消"逻辑只认它自己内部的 marks，不知道
  // savedMarks 的存在；如果对着一个已保存的标记调用它，会误判成"没有命中"
  // 从而新建一条重复标记，而不是取消。所以命中 savedMarks 时自己短路掉。
  const removeSavedMark = useCallback(
    (mark: Mark) => {
      setSavedMarks((ms) => ms.filter((m) => m.id !== mark.id))
      const serverId = Number(mark.id.slice(1))
      const request = deleteMark(serverId).catch(() => {
        showToast('取消这条标记时网络出错，刷新后可能会重新出现', 'error')
      })
      trackWrite(request)
    },
    [showToast, trackWrite],
  )

  const handleWordClick = useCallback(
    (pos: Pos) => {
      if (finishing) return
      if (marking.state.kind === 'idle') {
        const hit = marksAt(savedMarks, pos).find((m) => m.type === 'unknown_word')
        if (hit) {
          removeSavedMark(hit)
          return
        }
      } else if (marking.state.kind === 'armed') {
        const hit = marksAt(savedMarks, pos).find((m) => m.type === 'unclear')
        if (hit) {
          removeSavedMark(hit)
          return
        }
      }
      marking.clickWord(pos)
    },
    [finishing, marking, savedMarks, removeSavedMark],
  )

  // ---------- 本次会话新建标记的后台同步：先更新界面，再后台发请求 ----------
  // useMarking 的 marks 变化后用 diff 找出这一轮新增/删除了哪些本地标记，
  // 分别 POST / DELETE。不在点击的那一刻同步request，是为了不侵入 clickWord
  // 的调用点、也不必预判它这次到底是新增还是取消。
  const localToServerId = useRef<Map<string, number>>(new Map())
  const pendingCancel = useRef<Set<string>>(new Set())
  const prevHookMarks = useRef<Mark[]>([])
  useEffect(() => {
    marking.reset()
    localToServerId.current.clear()
    pendingCancel.current.clear()
    prevHookMarks.current = []
    setFinishing(false)
  }, [sessionId]) // marking methods are stable; session identity is the reset boundary

  useEffect(() => {
    if (!session || !article) return
    const prev = prevHookMarks.current
    const prevIds = new Set(prev.map((m) => m.id))
    const currIds = new Set(marking.marks.map((m) => m.id))

    for (const mark of marking.marks) {
      if (prevIds.has(mark.id)) continue
      const payload = toMarkCreatePayload(mark, article.paragraphs)
      const request = createMark(session.id, { ...payload, ...(bookRunId ? { bookRunId } : {}) })
        .then((dto) => {
          if (pendingCancel.current.delete(mark.id)) {
            // 还没落库就已经被用户点掉了：补一刀删除，界面早已经是"没有"的状态
            return deleteMark(dto.id).catch(() => undefined)
          }
          localToServerId.current.set(mark.id, dto.id)
        })
        .catch(() => {
          showToast('有一条标记没能存到服务器，请重新点一下', 'error')
        })
      trackWrite(request)
    }

    for (const mark of prev) {
      if (currIds.has(mark.id)) continue
      const serverId = localToServerId.current.get(mark.id)
      if (serverId === undefined) {
        pendingCancel.current.add(mark.id)
        continue
      }
      localToServerId.current.delete(mark.id)
      const request = deleteMark(serverId).catch(() => {
        showToast('取消这条标记时网络出错，刷新后可能会重新出现', 'error')
      })
      trackWrite(request)
    }

    prevHookMarks.current = marking.marks
  }, [marking.marks, session, article, showToast, bookRunId, trackWrite])

  // ---------- 崩溃保险：整份标记镜像到 localStorage ----------
  useEffect(() => {
    if (!session) return
    try {
      localStorage.setItem(`reading-saas:session:${session.id}:marks`, JSON.stringify(allMarks))
    } catch {
      // 存不进去（隐私模式 / 配额满）不是致命问题，忽略
    }
  }, [session, allMarks])

  // ---------- 阅读进度：滚动防抖后 PATCH ----------
  const scrollRestored = useRef(false)
  useEffect(() => {
    scrollRestored.current = false
  }, [sessionId])
  useEffect(() => {
    if (!session || !article || scrollRestored.current) return
    scrollRestored.current = true
    requestAnimationFrame(() => window.scrollTo(0, session.scrollPosition))
  }, [session, article])

  useEffect(() => {
    if (!session) return
    let timer: number | undefined
    const onScroll = () => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        updateSession(sessionId, { scrollPosition: Math.round(window.scrollY) }).catch(() => {
          // 阅读进度不是关键数据，静默失败，下次滚动会再存一次
        })
      }, SCROLL_DEBOUNCE_MS)
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      window.removeEventListener('scroll', onScroll)
      window.clearTimeout(timer)
    }
  }, [session, sessionId])

  // ---------- 断网提示 ----------
  useEffect(() => {
    const onOffline = () => showToast('网络已断开，标记会先留在本地，恢复后请确认已同步', 'error', 0)
    const onOnline = () => showToast('网络已恢复', 'info')
    window.addEventListener('offline', onOffline)
    window.addEventListener('online', onOnline)
    return () => {
      window.removeEventListener('offline', onOffline)
      window.removeEventListener('online', onOnline)
    }
  }, [showToast])

  // ---------- 完成阅读 ----------
  const finish = useCallback(async () => {
    if (!session || finishing) return
    setFinishing(true)
    await flushWrites()
    if (articleDto?.bookContext && bookRunId) {
      try {
        await finishBookReading(articleDto.bookContext.bookId, bookRunId)
        navigate(`/books/${articleDto.bookContext.bookId}/review?run=${bookRunId}`)
      } catch {
        showToast('结束本次阅读失败，请重试', 'error')
        setFinishing(false)
      }
      return
    }
    updateSession(session.id, { status: 'finished' })
      .catch(() => {
        // 状态没存上也不阻塞去汇总页；Review 页会重新拉一次会话
      })
      .finally(() => {
        navigate(`/review/${session.id}`)
      })
  }, [session, finishing, navigate, articleDto, bookRunId, showToast, flushWrites])

  const goBookPage = useCallback(
    async (articleId: number, finishCurrent: boolean) => {
      if (!session || !articleDto?.bookContext || !bookRunId || finishing) return
      setFinishing(true)
      await flushWrites()
      try {
        if (finishCurrent) await updateSession(session.id, { status: 'finished' })
        const opened = await openBookPage(articleDto.bookContext.bookId, bookRunId, articleId)
        navigate(`/read/${opened.sessionId}?run=${bookRunId}`)
      } catch {
        showToast('翻页失败，请重试', 'error')
        setFinishing(false)
      }
    },
    [session, articleDto, bookRunId, finishing, navigate, showToast, flushWrites],
  )

  // F 快捷键完成阅读（architecture.md §6：1 黄笔 / 2 粉笔 / Esc 取消 / F 完成阅读）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'f' || e.key === 'F') finish()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [finish])

  if (loadError) {
    return (
      <div className="wrap">
        <p className="error-banner">{loadError}</p>
        <Link to="/">返回文章库</Link>
      </div>
    )
  }

  if (!session || !article || !articleDto) {
    return (
      <div className="wrap">
        <p className="dim">加载中…</p>
      </div>
    )
  }

  return (
    <div className="app">
      <PenToolbar
        pen={marking.pen}
        state={marking.state}
        counts={counts}
        onSetPen={marking.setPen}
        onFinish={finish}
        finishLabel={articleDto.bookContext ? '结束本次阅读' : '完成阅读'}
      />

      <div className="wrap">
        <Link className="back-link" to={articleDto.bookContext ? `/books/${articleDto.bookContext.bookId}` : '/'}>
          ← {articleDto.bookContext ? '返回目录' : '返回文章库'}
        </Link>
        <h1 className="title">{article.title}</h1>
        <div className="meta">
          {articleDto.bookContext && `${articleDto.bookContext.sectionTitle} · 第 ${articleDto.bookContext.pageNumber}/${articleDto.bookContext.pageCount} 页 · `}
          {article.author || '佚名'} · {article.wordCount} 词 · 约 {article.estMinutes} 分钟
        </div>

        <ArticleBody
          paragraphs={article.paragraphs}
          marks={allMarks}
          preview={marking.preview}
          onWordClick={handleWordClick}
          onWordHover={marking.hoverWord}
          layout={articleDto.bookPageLayout}
          imageUrl={
            articleDto.bookContext
              ? (key) => `/api/books/${articleDto.bookContext!.bookId}/assets/${key}`
              : undefined
          }
        />

        {articleDto.bookContext && bookRunId && (
          <nav className="book-page-nav" aria-label="书页导航">
            <button
              className="btn-secondary"
              disabled={!articleDto.bookContext.previousArticleId || finishing}
              onClick={() => void goBookPage(articleDto.bookContext!.previousArticleId!, false)}
            >
              ← 上一页
            </button>
            {articleDto.bookContext.nextArticleId ? (
              <button
                className="btn-primary"
                disabled={finishing}
                onClick={() => void goBookPage(articleDto.bookContext!.nextArticleId!, true)}
              >
                读完本页，下一页 →
              </button>
            ) : (
              <button className="btn-primary" disabled={finishing} onClick={() => void finish()}>
                结束本次阅读
              </button>
            )}
          </nav>
        )}
      </div>

      {toast && <div className={`sync-toast sync-toast--${toast.kind}`}>{toast.text}</div>}
    </div>
  )
}
