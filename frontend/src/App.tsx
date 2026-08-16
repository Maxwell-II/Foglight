import { useMemo, useState } from 'react'
import type { Article } from './types'
import { useMarking } from './hooks/useMarking'
import { ArticleBody } from './components/reader/ArticleBody'
import { PenToolbar } from './components/reader/PenToolbar'
import { buildMarkdown } from './lib/export'
import { cmp } from './lib/pos'
import raw from './sampleArticles.json'

const ARTICLES = raw as Article[]

export default function App() {
  const [idx, setIdx] = useState(0)
  const [done, setDone] = useState(false)
  const article = ARTICLES[idx]

  const { pen, setPen, state, marks, preview, counts, clickWord, hoverWord, reset } = useMarking(
    article.paragraphs,
  )

  const markdown = useMemo(() => buildMarkdown(article, marks), [article, marks])

  const switchTo = (i: number) => {
    setIdx(i)
    setDone(false)
    reset()
  }

  const sorted = [...marks].sort((a, b) => cmp(a.start, b.start))

  return (
    <div className="app">
      <PenToolbar
        pen={pen}
        state={state}
        counts={counts}
        onSetPen={setPen}
        onFinish={() => setDone((d) => !d)}
      />

      <div className="wrap">
        <nav className="picker">
          {ARTICLES.map((a, i) => (
            <button key={a.id} className={i === idx ? 'is-active' : ''} onClick={() => switchTo(i)}>
              {a.title}
            </button>
          ))}
        </nav>

        <h1 className="title">{article.title}</h1>
        <div className="meta">
          {article.author} · {article.wordCount} 词 · 约 {article.estMinutes} 分钟
        </div>

        <ArticleBody
          paragraphs={article.paragraphs}
          marks={marks}
          preview={preview}
          onWordClick={clickWord}
          onWordHover={hoverWord}
        />

        {done && (
          <section className="review">
            <h2>本次标记（{marks.length}）</h2>
            {sorted.length === 0 && <p className="dim">还没有任何标记。</p>}
            <ul className="mark-list">
              {sorted.map((m) => (
                <li key={m.id} className={m.type === 'unknown_word' ? 'li-yellow' : 'li-pink'}>
                  <span className="tag">{m.type === 'unknown_word' ? '陌生词' : '模糊处'}</span>
                  {m.text}
                </li>
              ))}
            </ul>
            <h2>导出</h2>
            <textarea className="export" readOnly value={markdown} onFocus={(e) => e.target.select()} />
            <button
              className="btn-primary"
              onClick={() => navigator.clipboard.writeText(markdown)}
            >
              复制到剪贴板
            </button>
          </section>
        )}
      </div>
    </div>
  )
}
