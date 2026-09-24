/**
 * 忘记密码（v1 静态说明页）。
 *
 * v1 不做自助重置（user-flows §0 第三条）：账号丢了的人仍然能读，只丢历史。
 * 这页必须存在、不能是死链接 —— 联系方式还没定时就明说「即将公布」，
 * 而不是摆一个点了没反应的链接。
 */

import { Link } from 'react-router-dom'
import SupportContact from '../components/SupportContact'
import '../styles/login.css'

export default function ForgotPage() {
  return (
    <div className="wrap login-wrap">
      <Link className="brand" to="/">
        Foglight
      </Link>

      <h1 className="title login-title" style={{ marginTop: 32 }}>
        忘记密码
      </h1>

      <div className="login-card forgot-card">
        <p>现在还没有自助重置密码，需要人工帮你重置。自助重置正在做。</p>
        <p>
          联系：<SupportContact subject="Foglight 重置密码" />
          <br />
          <span className="dim">请用注册时的邮箱联系，说明要重置哪个账号。</span>
        </p>
        <p className="dim">
          用 Google 登录的账号没有密码，直接回登录页点 Google 就行。
        </p>
        <p className="dim">
          等待期间也能照常读：不登录时标记存在这台浏览器里，找回账号后登录会问你要不要带进去。
        </p>
      </div>

      <p className="auth-footnote">
        <Link to="/login">← 返回登录</Link>
        <span aria-hidden="true"> · </span>
        <Link to="/">不登录，先去读一篇</Link>
      </p>
    </div>
  )
}
