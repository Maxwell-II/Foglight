import { Link } from 'react-router-dom'
import type { MarkingState, Pen } from '../../types'

interface Props {
  pen: Pen
  state: MarkingState
  counts: { unknown: number; unclear: number }
  /** 粉笔延伸中，起点那个词的原文；不在 extending 态时是 null */
  anchorText?: string | null
  /** 顶栏左侧的返回目标和文章名 —— 阅读器在壳外面，它自己就是自己的导航 */
  backTo: string
  backLabel: string
  title: string
  onSetPen: (pen: Pen) => void
  onCancel?: () => void
  onFinish: () => void
  finishLabel?: string
}

function BackIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M15 5l-7 7 7 7" />
    </svg>
  )
}

/**
 * 底部浮出的胶囊。v2 用它取代了原来「把工具栏底边染色」的做法 ——
 * 颜色能说「现在是粉笔」，说不了「起点定在哪个词」，而范围标记走到一半时
 * 后者才是唯一要紧的信息。桌面和手机是同一个组件。
 *
 * 模式化的界面必须让人一眼看出「现在处于什么状态」，且不能只讲操作步骤：
 * 陌生词 / 模糊处标的是两种不同的东西，所以 armed 态也要出一句，
 * 说清「这支笔是干什么用的」，不只是「怎么点」。
 */
function MarkCapsule({
  state,
  anchorText,
  onCancel,
}: Pick<Props, 'state' | 'anchorText' | 'onCancel'>) {
  if (state.kind === 'idle') return null

  if (state.kind === 'armed') {
    return (
      <div className="capsule capsule--hint" role="status">
        <span className="capsule__text">模糊处标一整段读不懂的话 —— 点第一个词定起点</span>
      </div>
    )
  }

  return (
    <div className="capsule" role="status">
      <span className="capsule__text">
        起点：<strong className="capsule__anchor">{anchorText ?? '…'}</strong>
        <span className="capsule__aside">再点一下收尾</span>
      </span>
      <button type="button" className="capsule__cancel" onClick={onCancel}>
        取消 · Esc
      </button>
    </div>
  )
}

export function PenToolbar({
  pen,
  state,
  counts,
  anchorText,
  backTo,
  backLabel,
  title,
  onSetPen,
  onCancel,
  onFinish,
  finishLabel = '读完了',
}: Props) {
  return (
    <>
      <div className="reader-bar">
        <div className="reader-bar__left">
          <Link className="icon-button" to={backTo} aria-label={backLabel} title={backLabel}>
            <BackIcon />
          </Link>
          <span className="lamp lamp--sm" aria-hidden="true" />
          <span className="reader-bar__title">{title}</span>
        </div>

        <div className="segmented" role="group" aria-label="笔">
          <button
            type="button"
            className="pen--yellow"
            aria-pressed={pen === 'yellow'}
            onClick={() => onSetPen('yellow')}
          >
            <span className="swatch" aria-hidden="true" /> 陌生词
            <span className="pen__badge">{counts.unknown}</span>
          </button>
          <button
            type="button"
            className="pen--pink"
            aria-pressed={pen === 'pink'}
            onClick={() => onSetPen('pink')}
          >
            <span className="swatch" aria-hidden="true" /> 模糊处
            <span className="pen__badge">{counts.unclear}</span>
          </button>
        </div>

        <div className="reader-bar__right">
          <span className="counts">
            <span className="counts__item">
              <span className="dot dot--yellow" aria-hidden="true" />
              {counts.unknown}
            </span>
            <span className="counts__item">
              <span className="dot dot--pink" aria-hidden="true" />
              {counts.unclear}
            </span>
          </span>
          <button className="btn-primary" type="button" onClick={onFinish}>
            {finishLabel}
          </button>
        </div>
      </div>

      <MarkCapsule state={state} anchorText={anchorText} onCancel={onCancel} />
    </>
  )
}
