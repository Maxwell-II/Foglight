import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import {
  ApiError,
  createMark,
  deleteMark,
  getArticle,
  getSession,
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

  const [session, setSession] = useState<SessionDetailDto | null>(null)
  const [articleDto, setArticleDto] = useState<ArticleDetailDto | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  // 已经落库的标记（会话详情带回来的），和 useMarking 本次会话内新建的标记分开管理——
  // useMarking 没有暴露"注入初始标记"的接口（也不该有，那不是它的职责），
  // 所以已保存的走这份独立状态，渲染时和 useMarking 的 marks 合并。
  const [savedMarks, setSavedMarks] = useState<Mark[]>([])

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
      deleteMark(serverId).catch(() => {
        showToast('取消这条标记时网络出错，刷新后可能会重新出现', 'error')
      })
    },
    [showToast],
  )

  const handleWordClick = useCallback(
    (pos: Pos) => {
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
    [marking, savedMarks, removeSavedMark],
  )

  // ---------- 本次会话新建标记的后台同步：先更新界面，再后台发请求 ----------
  // useMarking 的 marks 变化后用 diff 找出这一轮新增/删除了哪些本地标记，
  // 分别 POST / DELETE。不在点击的那一刻同步request，是为了不侵入 clickWord
  // 的调用点、也不必预判它这次到底是新增还是取消。
  const localToServerId = useRef<Map<string, number>>(new Map())
  const pendingCancel = useRef<Set<string>>(new Set())
  const prevHookMarks = useRef<Mark[]>([])

  useEffect(() => {
    if (!session || !article) return
    const prev = prevHookMarks.current
    const prevIds = new Set(prev.map((m) => m.id))
    const currIds = new Set(marking.marks.map((m) => m.id))

    for (const mark of marking.marks) {
      if (prevIds.has(mark.id)) continue
      const payload = toMarkCreatePayload(mark, article.paragraphs)
      createMark(session.id, payload)
        .then((dto) => {
          if (pendingCancel.current.delete(mark.id)) {
            // 还没落库就已经被用户点掉了：补一刀删除，界面早已经是"没有"的状态
            deleteMark(dto.id).catch(() => undefined)
            return
          }
          localToServerId.current.set(mark.id, dto.id)
        })
        .catch(() => {
          showToast('有一条标记没能存到服务器，请重新点一下', 'error')
        })
    }

    for (const mark of prev) {
      if (currIds.has(mark.id)) continue
      const serverId = localToServerId.current.get(mark.id)
      if (serverId === undefined) {
        pendingCancel.current.add(mark.id)
        continue
      }
      localToServerId.current.delete(mark.id)
      deleteMark(serverId).catch(() => {
        showToast('取消这条标记时网络出错，刷新后可能会重新出现', 'error')
      })
    }

    prevHookMarks.current = marking.marks
  }, [marking.marks, session, article, showToast])

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
    if (!session || !article || scrollRestored.current) return
    scrollRestored.current = true
    if (session.scrollPosition > 0) {
      requestAnimationFrame(() => window.scrollTo(0, session.scrollPosition))
    }
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
  const [finishing, setFinishing] = useState(false)
  const finish = useCallback(() => {
    if (!session || finishing) return
    setFinishing(true)
    updateSession(session.id, { status: 'finished' })
      .catch(() => {
        // 状态没存上也不阻塞去汇总页；Review 页会重新拉一次会话
      })
      .finally(() => {
        navigate(`/review/${session.id}`)
      })
  }, [session, finishing, navigate])

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

  if (!session || !article) {
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
      />

      <div className="wrap">
        <Link className="back-link" to="/">
          ← 返回文章库
        </Link>
        <h1 className="title">{article.title}</h1>
        <div className="meta">
          {article.author || '佚名'} · {article.wordCount} 词 · 约 {article.estMinutes} 分钟
        </div>

        <ArticleBody
          paragraphs={article.paragraphs}
          marks={allMarks}
          preview={marking.preview}
          onWordClick={handleWordClick}
          onWordHover={marking.hoverWord}
        />
      </div>

      {toast && <div className={`sync-toast sync-toast--${toast.kind}`}>{toast.text}</div>}
    </div>
  )
}
