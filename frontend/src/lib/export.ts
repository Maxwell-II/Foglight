import type { Article, Mark } from '../types'
import { cmp } from './pos'

/** 取标记所在段落作为上下文，太长就截断。 */
function contextFor(article: Article, p: number): string {
  const raw = article.paragraphs[p]?.join(' ') ?? ''
  return raw.length > 240 ? `${raw.slice(0, 240)}…` : raw
}

/**
 * 把本次标记导出成 Markdown，用于丢给 agent 讨论。
 * Phase 1 会把同样的逻辑挪到后端 services/export.py —— 届时此文件删除。
 */
export function buildMarkdown(article: Article, marks: Mark[]): string {
  const unknown = marks.filter((m) => m.type === 'unknown_word').sort((a, b) => cmp(a.start, b.start))
  const unclear = marks.filter((m) => m.type === 'unclear').sort((a, b) => cmp(a.start, b.start))

  const lines: string[] = []
  lines.push(`# 阅读复盘素材：${article.title}`)
  lines.push('')
  lines.push(`来源：${article.source} — ${article.author}`)
  lines.push(`陌生词 ${unknown.length} 处，模糊处 ${unclear.length} 处。`)
  lines.push('')

  lines.push('## 原文')
  lines.push('')
  article.paragraphs.forEach((words) => {
    lines.push(words.join(' '))
    lines.push('')
  })

  lines.push('## 陌生词标记')
  lines.push('')
  if (unknown.length === 0) lines.push('（无）')
  unknown.forEach((m) => {
    lines.push(`- **${m.text}** — 所在段落：${contextFor(article, m.start.p)}`)
  })
  lines.push('')

  lines.push('## 模糊处标记')
  lines.push('')
  if (unclear.length === 0) lines.push('（无）')
  unclear.forEach((m) => {
    lines.push(`- **"${m.text}"** — 所在段落：${contextFor(article, m.start.p)}`)
  })
  lines.push('')

  lines.push('---')
  lines.push('请针对以上标记，先问我对每一处的理解，再解释；不要直接整段翻译。')
  return lines.join('\n')
}
