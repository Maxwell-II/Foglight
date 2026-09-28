/**
 * 注册页。邮箱表单和 Google 按钮**并排**（design-brief §8）：
 * 国内直连打不开 Google，只给 Google = 多数人面对一个转圈的按钮；
 * 只给邮箱 = 能用 Google 的人白填一张表。两条路必须同时看得见。
 *
 * 邮箱注册是两步（2026-09-28）：先收邮件验证码，再设密码 —— 表单在 <EmailCodeForm>。
 * 没通过邮件验证就不建账号。
 *
 * 成功后后端已经写好登录 cookie，直接进 /library —— 本地标记的迁移询问
 * 由 <RequireAuth> 在进入已登录区域时弹出，这里不管。
 */

import { Link, useNavigate } from 'react-router-dom'
import EmailCodeForm from '../components/EmailCodeForm'
import { GoogleButton, useGoogleAvailable } from '../components/GoogleSignIn'
import { resetGuestImportDismissal } from '../lib/guestStorage'
import '../styles/login.css'

export default function RegisterPage() {
  const navigate = useNavigate()
  const googleAvailable = useGoogleAvailable()

  const onDone = () => {
    resetGuestImportDismissal()
    navigate('/library', { replace: true })
  }

  return (
    <div className={`wrap login-wrap${googleAvailable ? ' register-wrap' : ''}`}>
      <Link className="brand" to="/">
        Foglight
      </Link>

      <h1 className="title login-title" style={{ marginTop: 32 }}>
        注册
      </h1>
      <p className="dim login-sub">
        注册之后，阅读记录存在账号里，换设备也在。没登录时在这台浏览器里标过的，进去后会问你要不要一起带上。
      </p>

      <div className="auth-split">
        <div className="login-card">
          <EmailCodeForm mode="register" onDone={onDone} />
        </div>

        {googleAvailable && (
          <div className="login-card auth-alt">
            <GoogleButton />
            <p className="dim auth-alt__note">
              能打开 Google 的话，一键就好，不用收验证码，也不用记密码。打不开时用邮箱注册，两种账号用起来完全一样。
            </p>
          </div>
        )}
      </div>

      <p className="auth-footnote">
        已经有账号？<Link to="/login">登录</Link>
        <span aria-hidden="true"> · </span>
        <Link to="/privacy">注册前可以先看隐私说明：存什么、存多久</Link>
      </p>
    </div>
  )
}
