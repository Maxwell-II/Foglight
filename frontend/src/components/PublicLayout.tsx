/**
 * 公开页面（落地页、游客读完页）的外壳：顶上一条品牌 + 登录/注册 + 主题，下面是内容。
 *
 * 不复用 <AppShell>：那个壳要登录（它一挂上就去拉 /articles 和 /books），
 * 而且侧栏里的东西游客一样都用不上。游客阅读器则连这个壳都不套 ——
 * 和登录后的阅读器一样整屏只剩正文。
 */

import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import ThemeToggle from './ThemeToggle'

export function PublicHeader({ actions }: { actions?: ReactNode }) {
  return (
    <header className="public-header">
      <Link className="public-header__brand" to="/" title="Foglight 首页">
        <span className="lamp" aria-hidden="true" />
        <span>Foglight</span>
      </Link>
      <div className="public-header__actions">
        {actions === undefined ? (
          <>
            <Link className="btn-secondary" to="/login">
              登录
            </Link>
            <Link className="btn-primary" to="/register">
              注册
            </Link>
          </>
        ) : (
          actions
        )}
        <ThemeToggle />
      </div>
    </header>
  )
}

export default function PublicLayout({
  actions,
  children,
}: {
  /** 右上角的按钮。不传就是「登录 / 注册」；传 null 就只剩主题按钮 */
  actions?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="public">
      <PublicHeader actions={actions} />
      <main className="public-main">{children}</main>
    </div>
  )
}
