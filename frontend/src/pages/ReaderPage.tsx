import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ApiError, finishBookReading, openBookPage, toArticle, toMarkCreatePayload } from '../api/client'
import { useMarking } from '../hooks/useMarking'
import { useCurrentParagraph } from '../hooks/useCurrentParagraph'
import { useReadingStore, type ReadingMode } from '../hooks/useReadingStore'
import { ArticleBody } from '../components/reader/ArticleBody'
import { PenToolbar } from '../components/reader/PenToolbar'
import { guestStorageAvailable } from '../lib/guestStorage'
import type { LoadedReading } from '../lib/readingStore'
import { marksAt } from '../lib/pos'
import type { Mark, Pos } from '../types'

const SCROLL_DEBOUNCE_MS = 800
const TOAST_MS = 4000

/**
 * 阅读器。登录用户（/read/:sessionId）和游客（/try/:articleId）共用这一份 ——
 * 区别全在 useReadingStore 挑出来的存储实现里，页面本身不分叉。
 * 书相关的分支（bookRunId、翻页、结束本次阅读）只在服务端模式下出现。
 */
export default function ReaderPage({ mode }: { mode: ReadingMode }) {
  const { store, bookRunId } = useReadingStore(mode)
  const navigate = useNavigate()

  const [loaded, setLoaded] = useState<LoadedReading | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  // 已经存下来的标记（load 带回来的），和 useMarking 本次会话内新建的标记分开管理——
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
    setLoaded(null)
    setSavedMarks([])
    setLoadError(null)

    store
      .load()
      .then((result) => {
        if (cancelled) return
        setLoaded(result)
        setSavedMarks(result.marks)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setLoadError(err instanceof ApiError ? err.message : '加载失败，请检查网络后刷新重试。')
      })

    return () => {
      cancelled = true
    }
  }, [store])

  // 游客的标记只存在这台浏览器里；浏览器连这个都不让存时，得当场说，不能等他读完才发现
  useEffect(() => {
    if (store.kind === 'guest' && loaded && !guestStorageAvailable()) {
      showToast('这个浏览器不允许本地存储：关掉页面后，这次的标记不会留下', 'info', 8000)
    }
  }, [store.kind, loaded, showToast])

  const articleDto = loaded?.article ?? null
  const article = useMemo(() => (articleDto ? toArticle(articleDto) : null), [articleDto])
  // 书只属于登录用户。公开文章本来就不带 bookContext，这里再挡一次，游客永远走不进书的分支
  const bookContext = store.kind === 'server' ? (articleDto?.bookContext ?? null) : null

  // 正文左侧的灯条：读到哪一段，哪一段亮
  const bodyRef = useRef<HTMLDivElement>(null)
  const currentParagraph = useCurrentParagraph(bodyRef, article)

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
      const request = store.removeMark(mark.id).catch(() => {
        showToast('取消这条标记时出错，刷新后可能会重新出现', 'error')
      })
      trackWrite(request)
    },
    [store, showToast, trackWrite],
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

  // ---------- 本次会话新建标记的后台同步：先更新界面，再后台写存储 ----------
  // useMarking 的 marks 变化后用 diff 找出这一轮新增/删除了哪些本地标记，
  // 分别 addMark / removeMark。不在点击的那一刻同步，是为了不侵入 clickWord
  // 的调用点、也不必预判它这次到底是新增还是取消。
  // 游客模式下存储是同步的 localStorage，这套 pending 机制照样成立，只是永远不会真的等。
  const localToStoredId = useRef<Map<string, string>>(new Map())
  const pendingCancel = useRef<Set<string>>(new Set())
  const prevHookMarks = useRef<Mark[]>([])
  useEffect(() => {
    marking.reset()
    localToStoredId.current.clear()
    pendingCancel.current.clear()
    prevHookMarks.current = []
    setFinishing(false)
  }, [store.key]) // marking methods are stable; the reading identity is the reset boundary

  useEffect(() => {
    if (!loaded || !article) return
    const prev = prevHookMarks.current
    const prevIds = new Set(prev.map((m) => m.id))
    const currIds = new Set(marking.marks.map((m) => m.id))

    for (const mark of marking.marks) {
      if (prevIds.has(mark.id)) continue
      const payload = toMarkCreatePayload(mark, article.paragraphs)
      const request = store
        .addMark(mark, payload)
        .then((storedId) => {
          if (pendingCancel.current.delete(mark.id)) {
            // 还没存下来就已经被用户点掉了：补一刀删除，界面早已经是"没有"的状态
            return store.removeMark(storedId).catch(() => undefined)
          }
          localToStoredId.current.set(mark.id, storedId)
        })
        .catch(() => {
          showToast('有一条标记没能存下来，请重新点一下', 'error')
        })
      trackWrite(request)
    }

    for (const mark of prev) {
      if (currIds.has(mark.id)) continue
      const storedId = localToStoredId.current.get(mark.id)
      if (storedId === undefined) {
        pendingCancel.current.add(mark.id)
        continue
      }
      localToStoredId.current.delete(mark.id)
      const request = store.removeMark(storedId).catch(() => {
        showToast('取消这条标记时出错，刷新后可能会重新出现', 'error')
      })
      trackWrite(request)
    }

    prevHookMarks.current = marking.marks
  }, [marking.marks, loaded, article, store, showToast, trackWrite])

  // ---------- 崩溃保险：整份标记镜像一份（只有服务端实现真的会写） ----------
  useEffect(() => {
    if (!loaded) return
    store.snapshot(allMarks)
  }, [store, loaded, allMarks])

  // ---------- 阅读进度：滚动防抖后保存 ----------
  const scrollRestored = useRef(false)
  useEffect(() => {
    scrollRestored.current = false
  }, [store.key])
  useEffect(() => {
    if (!loaded || !article || scrollRestored.current) return
    scrollRestored.current = true
    requestAnimationFrame(() => window.scrollTo(0, loaded.scrollPosition))
  }, [loaded, article])

  useEffect(() => {
    if (!loaded) return
    let timer: number | undefined
    const onScroll = () => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        store.saveScroll(Math.round(window.scrollY)).catch(() => {
          // 阅读进度不是关键数据，静默失败，下次滚动会再存一次
        })
      }, SCROLL_DEBOUNCE_MS)
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      window.removeEventListener('scroll', onScroll)
      window.clearTimeout(timer)
    }
  }, [loaded, store])

  // ---------- 断网提示 ----------
  // 游客的标记本来就只在浏览器里，断不断网都不影响，说了反而吓人
  useEffect(() => {
    if (store.kind !== 'server') return
    const onOffline = () => showToast('网络已断开，标记会先留在本地，恢复后请确认已同步', 'error', 0)
    const onOnline = () => showToast('网络已恢复', 'info')
    window.addEventListener('offline', onOffline)
    window.addEventListener('online', onOnline)
    return () => {
      window.removeEventListener('offline', onOffline)
      window.removeEventListener('online', onOnline)
    }
  }, [store.kind, showToast])

  // ---------- 完成阅读 ----------
  const finish = useCallback(async () => {
    if (!loaded || finishing) return
    setFinishing(true)
    await flushWrites()
    if (bookContext && bookRunId) {
      try {
        await finishBookReading(bookContext.bookId, bookRunId)
        navigate(`/books/${bookContext.bookId}/review?run=${bookRunId}`)
      } catch {
        showToast('结束本次阅读失败，请重试', 'error')
        setFinishing(false)
      }
      return
    }
    store
      .finish()
      .catch(() => {
        // 状态没存上也不阻塞去汇总页；汇总页会重新读一次
      })
      .finally(() => {
        navigate(store.reviewPath)
      })
  }, [loaded, finishing, navigate, bookContext, bookRunId, showToast, flushWrites, store])

  const goBookPage = useCallback(
    async (articleId: number, finishCurrent: boolean) => {
      if (!loaded || !bookContext || !bookRunId || finishing) return
      setFinishing(true)
      await flushWrites()
      try {
        if (finishCurrent) await store.finish()
        const opened = await openBookPage(bookContext.bookId, bookRunId, articleId)
        navigate(`/read/${opened.sessionId}?run=${bookRunId}`)
      } catch {
        showToast('翻页失败，请重试', 'error')
        setFinishing(false)
      }
    },
    [loaded, bookContext, bookRunId, finishing, navigate, showToast, flushWrites, store],
  )

  // 粉笔延伸中，状态条要报「起点是哪个词」——只在这一状态下算，其余时候是 null
  const anchorText = useMemo(() => {
    if (marking.state.kind !== 'extending' || !article) return null
    const { p, w } = marking.state.anchor
    return article.paragraphs[p]?.[w] ?? null
  }, [marking.state, article])

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
        <Link to={store.homePath}>{store.homeLabel}</Link>
      </div>
    )
  }

  if (!loaded || !article || !articleDto) {
    return (
      <div className="wrap">
        <p className="dim">加载中…</p>
      </div>
    )
  }

  return (
    <div className="reader-page">
      <PenToolbar
        pen={marking.pen}
        state={marking.state}
        counts={counts}
        anchorText={anchorText}
        backTo={bookContext ? `/books/${bookContext.bookId}` : store.homePath}
        backLabel={bookContext ? '返回目录' : store.homeLabel}
        title={article.title}
        onSetPen={marking.setPen}
        onCancel={marking.cancel}
        onFinish={finish}
        finishLabel={bookContext ? '结束本次阅读' : '读完了'}
      />

      {/* 640px 一栏，居中。返回和标题都搬进顶栏了，这里只剩正文本身 */}
      <div className="reader-column">
        <h1 className="article-title">{article.title}</h1>
        <div className="meta">
          {bookContext && `${bookContext.sectionTitle} · 第 ${bookContext.pageNumber}/${bookContext.pageCount} 页 · `}
          {article.author || '佚名'} · {article.wordCount} 词 · 约 {article.estMinutes} 分钟
          {/* 不是提示条，只是 meta 行尾一句：说实话，但不抢正文 */}
          {store.kind === 'guest' && ' · 未登录，标记只存在这台浏览器里'}
        </div>

        {/* 包一层只为给灯条的 IntersectionObserver 一个查询根；
            ArticleBody 不收 ref，也不该为了这件事改成 forwardRef */}
        <div ref={bodyRef}>
          <ArticleBody
            paragraphs={article.paragraphs}
            marks={allMarks}
            preview={marking.preview}
            onWordClick={handleWordClick}
            onWordHover={marking.hoverWord}
            layout={store.kind === 'server' ? articleDto.bookPageLayout : null}
            imageUrl={bookContext ? (key) => `/api/books/${bookContext.bookId}/assets/${key}` : undefined}
            currentParagraph={currentParagraph}
          />
        </div>

        {bookContext && bookRunId && (
          <nav className="book-page-nav" aria-label="书页导航">
            <button
              className="btn-secondary"
              disabled={!bookContext.previousArticleId || finishing}
              onClick={() => void goBookPage(bookContext.previousArticleId!, false)}
            >
              ← 上一页
            </button>
            {bookContext.nextArticleId ? (
              <button
                className="btn-primary"
                disabled={finishing}
                onClick={() => void goBookPage(bookContext.nextArticleId!, true)}
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
