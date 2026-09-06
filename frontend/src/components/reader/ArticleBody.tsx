import { Fragment } from 'react'
import type { Mark, Pos } from '../../types'
import { inRange, marksAt } from '../../lib/pos'
import type { BookPageLayoutItem } from '../../api/client'

interface Props {
  paragraphs: string[][]
  marks: Mark[]
  preview: { start: Pos; end: Pos } | null
  onWordClick: (pos: Pos) => void
  onWordHover: (pos: Pos) => void
  layout?: BookPageLayoutItem[] | null
  imageUrl?: (assetKey: string) => string
}

interface Flags {
  unknown: boolean
  unclear: boolean
  preview: boolean
}

const clsOf = (f: Flags, base: string) =>
  [base, f.unknown && 'is-unknown', f.unclear && 'is-unclear', f.preview && 'is-preview']
    .filter(Boolean)
    .join(' ')

export function ArticleBody({ paragraphs, marks, preview, onWordClick, onWordHover, layout, imageUrl }: Props) {
  const renderParagraph = (words: string[], p: number) => {
        // 先算出每个词的高亮状态，渲染时还要用它决定词间空格要不要一起高亮
        const flags: Flags[] = words.map((_, w) => {
          const pos = { p, w }
          const hits = marksAt(marks, pos)
          return {
            unknown: hits.some((m) => m.type === 'unknown_word'),
            unclear: hits.some((m) => m.type === 'unclear'),
            preview: preview ? inRange(pos, preview.start, preview.end) : false,
          }
        })

        return (
          <p className="paragraph" key={p}>
            {words.map((word, w) => {
              const f = flags[w]
              const next = flags[w + 1]
              // 词间空格：只有前后两个词属于同一种高亮时才连起来，
              // 否则短语会渲染成一个个断开的小色块，不像一道连续的笔划。
              const gap: Flags | null = next
                ? {
                    unknown: false, // 陌生词是单词级的，不跨空格连接
                    unclear: f.unclear && next.unclear,
                    preview: f.preview && next.preview,
                  }
                : null

              return (
                <Fragment key={w}>
                  <span
                    className={clsOf(f, 'word')}
                    data-p={p}
                    data-w={w}
                    onClick={() => onWordClick(pos(p, w))}
                    onMouseEnter={() => onWordHover(pos(p, w))}
                  >
                    {word}
                  </span>
                  {gap && <span className={clsOf(gap, 'gap')}> </span>}
                </Fragment>
              )
            })}
          </p>
        )
  }

  return (
    <div className="article-body">
      {layout
        ? layout.map((item, index) => {
            if (item.type === 'paragraph') {
              return renderParagraph(paragraphs[item.pIdx] ?? [], item.pIdx)
            }
            if (item.type === 'heading') {
              return <h2 className="book-page-heading" key={`heading-${index}`}>{item.text}</h2>
            }
            return imageUrl ? (
              <img
                className="book-page-image"
                key={`image-${index}`}
                src={imageUrl(item.assetKey)}
                alt="原书插图"
              />
            ) : null
          })
        : paragraphs.map(renderParagraph)}
    </div>
  )
}

const pos = (p: number, w: number): Pos => ({ p, w })
