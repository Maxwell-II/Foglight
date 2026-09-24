import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { ApiError } from '../api/client'
import { useReadingStore, type ReadingMode } from '../hooks/useReadingStore'
import type { LoadedReading } from '../lib/readingStore'
import { cmp } from '../lib/pos'
import BookNextChapter from '../components/BookNextChapter'
import SourceCredit from '../components/SourceCredit'

/** 下载用的文件名。标题里可能有 / : ? 之类在各系统上不合法的字符，换掉 */
function fileNameFor(title: string): string {
  const safe = title.replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)
  return `foglight-${safe || 'review'}.md`
}

/**
 * 读完页：标记汇总 + 导出。登录用户（/review/:sessionId）和游客（/try/:articleId/review）
 * 共用这一份，数据都从 useReadingStore 来。
 *
 * 这页的重心是「让人愿意把那段 Markdown 拿去用」（design-brief §5），不是展示统计。
 * 导出对游客同样完整可用 —— 那是产品的交付物，不放在注册墙后面。
 */
export default function ReviewPage({ mode }: { mode: ReadingMode }) {
  const { store } = useReadingStore(mode)

  const [loaded, setLoaded] = useState<LoadedReading | null>(null)
  const [markdown, setMarkdown] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const exportRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    let cancelled = false
    setLoaded(null)
    setMarkdown(null)
    setError(null)

    Promise.all([store.load(), store.exportMarkdown()])
      .then(([result, md]) => {
        if (cancelled) return
        setLoaded(result)
        setMarkdown(md)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err instanceof ApiError ? err.message : '加载失败，请检查网络后刷新重试。')
      })

    return () => {
      cancelled = true
    }
  }, [store])

  const sortedMarks = useMemo(() => {
    if (!loaded) return []
    return [...loaded.marks].sort((a, b) => cmp(a.start, b.start))
  }, [loaded])

  const copyMarkdown = async () => {
    if (!markdown) return
    try {
      await navigator.clipboard.writeText(markdown)
      setCopyState('copied')
    } catch {
      // 非 https / 浏览器不给剪贴板权限时会走到这里：把全文选中，让他自己按复制
      exportRef.current?.focus()
      exportRef.current?.select()
      setCopyState('failed')
    }
    window.setTimeout(() => setCopyState('idle'), 2500)
  }

  const downloadMarkdown = () => {
    if (!markdown || !loaded) return
    const url = URL.createObjectURL(new Blob([markdown], { type: 'text/markdown;charset=utf-8' }))
    const a = document.createElement('a')
    a.href = url
    a.download = fileNameFor(loaded.article.title)
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  }

  if (error) {
    return (
      <div className="page">
        <p className="error-banner">{error}</p>
        <Link to={store.homePath}>{store.homeLabel}</Link>
      </div>
    )
  }

  if (!loaded || markdown === null) {
    return (
      <div className="page">
        <p className="dim">加载中…</p>
      </div>
    )
  }

  const { article, status } = loaded
  const unknownCount = loaded.marks.filter((m) => m.type === 'unknown_word').length
  const unclearCount = loaded.marks.filter((m) => m.type === 'unclear').length

  return (
    <div className="page">
      <h1 className="title">复盘：{article.title}</h1>
      <div className="meta">
        {article.author ?? '佚名'} · {article.wordCount} 词 · 状态：
        {status === 'finished' ? '已完成' : status === 'abandoned' ? '已放弃' : '阅读中'}
        <SourceCredit url={article.sourceUrl} name={article.sourceName} />
      </div>

      <Link className="btn-primary" to={store.readerPath}>
        继续阅读
      </Link>

      <section className="review">
        <h2>本次标记（{loaded.marks.length}）</h2>
        <p className="dim">
          陌生词 {unknownCount} 处 · 模糊处 {unclearCount} 处
        </p>
        {sortedMarks.length === 0 && <p className="dim">还没有任何标记。</p>}
        <ul className="mark-list">
          {sortedMarks.map((m) => (
            <li key={m.id} className={m.type === 'unknown_word' ? 'li-yellow' : 'li-pink'}>
              <span className="tag">{m.type === 'unknown_word' ? '陌生词' : '模糊处'}</span>
              {m.text}
            </li>
          ))}
        </ul>

        <h2>导出</h2>
        <p className="dim review-export-hint">
          原文和你标的地方都在里面，末尾附一段复盘指令。复制到你常用的 AI 对话里，让它带你过一遍。
        </p>
        <textarea
          ref={exportRef}
          className="export"
          readOnly
          value={markdown}
          onFocus={(e) => e.target.select()}
        />
        <div className="review-actions">
          <button className="btn-primary" type="button" onClick={copyMarkdown}>
            {copyState === 'copied' ? '已复制' : '复制到剪贴板'}
          </button>
          <button className="btn-secondary" type="button" onClick={downloadMarkdown}>
            下载 .md
          </button>
          {copyState === 'failed' && (
            <span className="dim">浏览器不让直接复制，已经全选，按 Ctrl+C / ⌘C 即可。</span>
          )}
        </div>

        {/* user-flows §3 路径 1 第 5 步 / §7 第 2 句：落地页说过一次，这里必须再说一次 */}
        {store.kind === 'guest' && (
          <aside className="guest-note">
            <p>
              <strong>这些记录只存在这台浏览器里，清了就没了。</strong>
              换设备、清缓存、用无痕窗口，都看不到这一次的标记。
            </p>
            <p className="dim">想留住阅读历史，可以注册一个账号 —— 注册后会问你要不要把这些标记一起带进去。</p>
            <div className="guest-note__actions">
              <Link className="btn-primary" to="/register">
                注册，保存记录
              </Link>
              <Link className="btn-secondary" to="/">
                再读一篇
              </Link>
            </div>
          </aside>
        )}

        {/* 书里的章节才渲染，散篇文章时组件自己返回 null。
            放在复盘之后而不是读完直接跳下一章 —— 读完就复盘是这个产品的主张。
            游客没有书，也不该去打 /books（那要登录）。 */}
        {store.kind === 'server' && <BookNextChapter articleId={article.id} />}
      </section>
    </div>
  )
}
