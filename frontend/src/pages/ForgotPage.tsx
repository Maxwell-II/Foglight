/**
 * 忘记密码：邮件验证码重置（2026-09-28 起，推翻了 v1「只写人工联系方式」）。
 *
 * 发码时页面**不透露邮箱是否注册过** —— 后端对两种邮箱回一样的话，
 * 这里也只说「如果注册过，验证码已发出」（文案在 <EmailCodeForm>）。
 *
 * 重置成功后端已经登录好了，直接进 /library；这个账号在其他设备上的登录全部失效。
 * 人工联系方式仍然留着：发信没开（503）或者邮箱本身收不到的时候，那是唯一的路。
 */

import { Link, useNavigate } from 'react-router-dom'
import EmailCodeForm from '../components/EmailCodeForm'
import SupportContact from '../components/SupportContact'
import '../styles/login.css'

export default function ForgotPage() {
  const navigate = useNavigate()

  return (
    <div className="wrap login-wrap">
      <Link className="brand" to="/">
        Foglight
      </Link>

      <h1 className="title login-title" style={{ marginTop: 32 }}>
        忘记密码
      </h1>
      <p className="dim login-sub">往注册邮箱发一个验证码，凭它设一个新密码。</p>

      <div className="login-card">
        <EmailCodeForm mode="reset" onDone={() => navigate('/library', { replace: true })} />
      </div>

      <div className="login-card forgot-card">
        <p className="dim">用 Google 登录的账号没有密码，直接回登录页点 Google 就行。</p>
        <p className="dim">
          邮箱收不到信：联系 <SupportContact subject="Foglight 重置密码" />
          ，用注册时的邮箱写信，说明要重置哪个账号。
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
