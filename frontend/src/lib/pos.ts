import type { Mark, Pos } from '../types'

/** 比较两个位置的先后。<0 表示 a 在 b 前面。 */
export function cmp(a: Pos, b: Pos): number {
  return a.p !== b.p ? a.p - b.p : a.w - b.w
}

/** 把一对位置正规化成 [前, 后]，支持反向选择（从后往前选也能用）。 */
export function normalize(a: Pos, b: Pos): [Pos, Pos] {
  return cmp(a, b) <= 0 ? [a, b] : [b, a]
}

/** 位置是否落在 [start, end] 闭区间内（可跨段落）。 */
export function inRange(pos: Pos, start: Pos, end: Pos): boolean {
  return cmp(pos, start) >= 0 && cmp(pos, end) <= 0
}

/** 找出覆盖该位置的所有标记。 */
export function marksAt(marks: Mark[], pos: Pos): Mark[] {
  return marks.filter((m) => inRange(pos, m.start, m.end))
}

/** 取出 [start, end] 范围内的原文，用于标记的 text 字段。 */
export function sliceText(paragraphs: string[][], start: Pos, end: Pos): string {
  const out: string[] = []
  for (let p = start.p; p <= end.p; p++) {
    const para = paragraphs[p]
    if (!para) continue
    const from = p === start.p ? start.w : 0
    const to = p === end.p ? end.w : para.length - 1
    out.push(para.slice(from, to + 1).join(' '))
  }
  return out.join(' ')
}
