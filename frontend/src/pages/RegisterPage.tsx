/**
 * 注册页。邮箱表单和 Google 按钮**并排**（design-brief §8）：
 * 国内直连打不开 Google，只给 Google = 多数人面对一个转圈的按钮；
 * 只给邮箱 = 能用 Google 的人白填一张表。两条路必须同时看得见。
 *
 * 成功后后端已经写好登录 cookie，直接进 /library —— 本地标记的迁移询问
 * 由 <RequireAuth> 在进入已登录区域时弹出，这里不管。
 */

import { useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ApiError, register } from '../api/client'
import { GoogleButton, useGoogleAvailable } from '../components/GoogleSignIn'
import { resetGuestImportDismissal } from '../lib/guestStorage'
import '../styles/login.css'

const MIN_PASSWORD = 8

type RegisterError = { kind: 'exists' } | { kind: 'text'; text: string }

function errorFor(err: unknown): RegisterError {
  if (!(err instanceof ApiError)) return { kind: 'text', text: '连不上服务器，稍后再试。' }
  if (err.status === 409) return { kind: 'exists' }
  if (err.status === 429) return { kind: 'text', text: '尝试过于频繁，稍后再试。' }
  if (err.status === 422) return { kind: 'text', text: `邮箱格式不对，或者密码不到 ${MIN_PASSWORD} 位。` }
  return { kind: 'text', text: `注册请求失败（${err.status}）。` }
}

export default function RegisterPage() {
  const navigate = useNavigate()
  const googleAvailable = useGoogleAvailable()

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<RegisterError | null>(null)

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (submitting) return
    if (!email.trim() || !password) {
      setError({ kind: 'text', text: '邮箱和密码都要填。' })
      return
    }
    // 前端先挡一次只是省一个来回，真正的校验在后端（422）
    if (password.length < MIN_PASSWORD) {
      setError({ kind: 'text', text: `密码至少 ${MIN_PASSWORD} 位。` })
      return
    }

    setSubmitting(true)
    setError(null)
    try {
      await register({ email: email.trim(), password })
      resetGuestImportDismissal()
      navigate('/library', { replace: true })
    } catch (err) {
      setError(errorFor(err))
      setSubmitting(false)
    }
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

      {error && (
        <div className="error-banner" role="alert">
          {error.kind === 'exists' ? (
            <>
              该邮箱已注册。<Link to="/login">去登录</Link>
            </>
          ) : (
            error.text
          )}
        </div>
      )}

      <div className="auth-split">
        <div className="login-card">
          <form className="import-form login-form" onSubmit={onSubmit}>
            <label className="field">
              邮箱
              <input
                type="email"
                value={email}
                autoComplete="email"
                autoFocus
                onChange={(e) => setEmail(e.target.value)}
              />
            </label>

            <label className="field">
              密码
              <input
                type="password"
                value={password}
                autoComplete="new-password"
                minLength={MIN_PASSWORD}
                onChange={(e) => setPassword(e.target.value)}
              />
              <span className="field__hint">至少 {MIN_PASSWORD} 位。目前忘了只能人工重置，记好它。</span>
            </label>

            <button className="btn-primary login-submit" type="submit" disabled={submitting}>
              {submitting ? '注册中…' : '用邮箱注册'}
            </button>
          </form>
        </div>

        {googleAvailable && (
          <div className="login-card auth-alt">
            <GoogleButton />
            <p className="dim auth-alt__note">
              能打开 Google 的话，一键就好，也不用记密码。打不开时用邮箱注册，两种账号用起来完全一样。
            </p>
          </div>
        )}
      </div>

      <p className="auth-footnote">
        已经有账号？<Link to="/login">登录</Link>
      </p>
    </div>
  )
}
