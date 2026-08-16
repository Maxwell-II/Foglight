import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Mark, MarkingState, Pen, Pos } from '../types'
import { marksAt, normalize, sliceText } from '../lib/pos'

let seq = 0
const newId = () => `m${++seq}`

/**
 * 画笔状态机 —— 整个前端最核心的逻辑。
 * 状态转移严格对应 docs/architecture.md §6 的表格。
 */
export function useMarking(paragraphs: string[][]) {
  const [pen, setPenState] = useState<Pen>('yellow')
  const [state, setState] = useState<MarkingState>({ kind: 'idle' })
  const [marks, setMarks] = useState<Mark[]>([])

  /** 切笔。切到黄笔就等于收笔（丢弃进行中的范围）。 */
  const setPen = useCallback((next: Pen) => {
    setPenState(next)
    setState(next === 'pink' ? { kind: 'armed' } : { kind: 'idle' })
  }, [])

  /**
   * Esc：extending → armed（只丢弃当前范围）；armed → idle（收笔）。
   * ⚠️ 不要写成 setState(s => { ...副作用... })：updater 必须是纯函数，
   * 否则 React 双调用时副作用会执行两次。
   */
  const cancel = useCallback(() => {
    if (state.kind === 'extending') {
      setState({ kind: 'armed' })
      return
    }
    setPenState('yellow')
    setState({ kind: 'idle' })
  }, [state])

  const removeMark = useCallback((id: string) => {
    setMarks((ms) => ms.filter((m) => m.id !== id))
  }, [])

  const clickWord = useCallback(
    (pos: Pos) => {
      // —— 黄笔：点一下切换该词的「陌生词」标记 ——
      if (state.kind === 'idle') {
        const hit = marksAt(marks, pos).find((m) => m.type === 'unknown_word')
        if (hit) {
          setMarks((ms) => ms.filter((m) => m.id !== hit.id))
        } else {
          const mark: Mark = {
            id: newId(),
            type: 'unknown_word',
            start: pos,
            end: pos,
            text: paragraphs[pos.p]?.[pos.w] ?? '',
          }
          setMarks((ms) => [...ms, mark])
        }
        return
      }

      // —— 粉笔待命：点已有的模糊处 = 取消它；否则记下起点 ——
      if (state.kind === 'armed') {
        const hit = marksAt(marks, pos).find((m) => m.type === 'unclear')
        if (hit) {
          removeMark(hit.id)
          return
        }
        setState({ kind: 'extending', anchor: pos, hover: pos })
        return
      }

      // —— 粉笔延伸中：再点一下提交，然后留在 armed 以便连续标记 ——
      const [start, end] = normalize(state.anchor, pos)
      const mark: Mark = {
        id: newId(),
        type: 'unclear',
        start,
        end,
        text: sliceText(paragraphs, start, end),
      }
      setMarks((ms) => [...ms, mark])
      setState({ kind: 'armed' })
    },
    [state, marks, paragraphs, removeMark],
  )

  /** 鼠标滑过某个词：只在 extending 时更新预览。 */
  const hoverWord = useCallback((pos: Pos) => {
    setState((s) => (s.kind === 'extending' ? { ...s, hover: pos } : s))
  }, [])

  /** 当前正在预览的范围（已正规化），没有则为 null。 */
  const preview = useMemo(() => {
    if (state.kind !== 'extending') return null
    const [start, end] = normalize(state.anchor, state.hover)
    return { start, end }
  }, [state])

  // 快捷键：1 黄笔 / 2 粉笔 / Esc 取消
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === '1') setPen('yellow')
      else if (e.key === '2') setPen('pink')
      else if (e.key === 'Escape') cancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setPen, cancel])

  const counts = useMemo(
    () => ({
      unknown: marks.filter((m) => m.type === 'unknown_word').length,
      unclear: marks.filter((m) => m.type === 'unclear').length,
    }),
    [marks],
  )

  const reset = useCallback(() => {
    setMarks([])
    setState({ kind: 'idle' })
    setPenState('yellow')
  }, [])

  return { pen, setPen, state, marks, preview, counts, clickWord, hoverWord, cancel, removeMark, reset }
}
