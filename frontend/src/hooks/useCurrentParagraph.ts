import { useEffect, useState, type RefObject } from 'react'

/**
 * 「当前读到哪一段」—— 给正文左侧那根灯条用。
 *
 * 用 IntersectionObserver 而不是 scroll 监听：scroll 里逐段读
 * getBoundingClientRect() 每帧都会触发一次强制重排，长章节（几百段）上很贵。
 * rootMargin 把视口压成靠上三分之一处的一条窄带，落进这条带子的段就是当前段。
 *
 * 返回 -1 表示还没算出来（正文没挂载 / 一段都没进带子），调用方按「没有当前段」处理。
 */
export function useCurrentParagraph(containerRef: RefObject<HTMLElement | null>, deps: unknown): number {
  const [current, setCurrent] = useState(-1)

  useEffect(() => {
    const root = containerRef.current
    if (!root) return

    const paragraphs = Array.from(root.querySelectorAll<HTMLElement>('p.paragraph[data-p]'))
    if (paragraphs.length === 0) return

    // 带子里可能同时有好几段（短段落），取最靠上的那个。用 Set 记住谁在带子里，
    // 而不是在回调里只看本次变化的那几个 —— 后者在快速滚动时会漏掉。
    const inBand = new Set<HTMLElement>()

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const el = entry.target as HTMLElement
          if (entry.isIntersecting) inBand.add(el)
          else inBand.delete(el)
        }
        let top: HTMLElement | null = null
        for (const el of inBand) {
          if (!top || el.getBoundingClientRect().top < top.getBoundingClientRect().top) top = el
        }
        setCurrent(top ? Number(top.dataset.p) : -1)
      },
      { rootMargin: '-30% 0px -62% 0px', threshold: 0 },
    )

    for (const p of paragraphs) observer.observe(p)
    return () => observer.disconnect()
    // deps 由调用方给（通常是文章对象）：正文换了就要重新挂一批观察者
  }, [containerRef, deps])

  return current
}
