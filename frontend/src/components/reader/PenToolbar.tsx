import type { MarkingState, Pen } from '../../types'

interface Props {
  pen: Pen
  state: MarkingState
  counts: { unknown: number; unclear: number }
  /** 粉笔延伸中，起点那个词的原文；不在 extending 态时是 null */
  anchorText?: string | null
  onSetPen: (pen: Pen) => void
  onCancel?: () => void
  onFinish: () => void
  finishLabel?: string
}

/** 模式化的界面必须让人一眼看出「现在处于什么状态」，否则点下去不知道会发生什么。 */
function hintFor(state: MarkingState): string {
  switch (state.kind) {
    case 'idle':
      return '点单词 = 标记陌生词'
    case 'armed':
      return '点一个词作为起点'
    case 'extending':
      return '移动鼠标选范围，再点一下完成（Esc 取消）'
  }
}

export function PenToolbar({
  pen,
  state,
  counts,
  anchorText,
  onSetPen,
  onCancel,
  onFinish,
  finishLabel = '完成阅读',
}: Props) {
  return (
    <>
      <div className={`toolbar toolbar--${pen}`}>
        <div className="pens">
          <button
            className={`pen pen--yellow ${pen === 'yellow' ? 'is-active' : ''}`}
            onClick={() => onSetPen('yellow')}
          >
            <span className="swatch" /> 陌生词 <kbd>1</kbd>
            <span className="pen__badge">{counts.unknown}</span>
          </button>
          <button
            className={`pen pen--pink ${pen === 'pink' ? 'is-active' : ''}`}
            onClick={() => onSetPen('pink')}
          >
            <span className="swatch" /> 模糊处 <kbd>2</kbd>
            <span className="pen__badge">{counts.unclear}</span>
          </button>
        </div>

        <div className="hint-text">{hintFor(state)}</div>

        <div className="right">
          <span className="counts">
            <b>{counts.unknown}</b> 词 · <b>{counts.unclear}</b> 处
          </span>
          <button className="btn-primary" onClick={onFinish}>
            {finishLabel}
          </button>
        </div>
      </div>

      {state.kind === 'extending' && (
        <div className="status-bar">
          <div className="status-bar__lead">
            <span className="status-bar__dot" />
            <span className="status-bar__text">
              起点已定在 <strong>{anchorText ?? '…'}</strong> — 再点一下收尾
            </span>
          </div>
          <button type="button" className="status-bar__cancel" onClick={onCancel}>
            取消（Esc）
          </button>
        </div>
      )}
    </>
  )
}
