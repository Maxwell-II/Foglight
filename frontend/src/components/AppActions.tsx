/**
 * 右上角的全局操作区。
 *
 * 存在的理由：主题按钮和退出按钮以前各写各的 `position: fixed` + 硬编码
 * `right`（一个 12px、一个 54px），靠注释里抄对方的宽度来互相让位 ——
 * 任何一个变宽，另一个就压上去。现在两个按钮都不再自带定位，
 * 由这一层统一排。
 *
 * 它和阅读页 toolbar 的关系由 `--actions-w` 一个变量维系：
 * 这里用它当 min-width，toolbar 用它算 padding-right 把内容让开。
 * 要加第三个按钮，只改那一个变量。
 */

import type { ReactNode } from 'react'
import ThemeToggle from './ThemeToggle'

export default function AppActions({ children }: { children?: ReactNode }) {
  return (
    <div className="app-actions">
      {children}
      <ThemeToggle />
    </div>
  )
}
