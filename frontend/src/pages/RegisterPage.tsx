/**
 * 注册页。邮箱表单和 Google 按钮**并排**（design-brief §8）：
 * 国内直连打不开 Google，只给 Google = 多数人面对一个转圈的按钮；
 * 只给邮箱 = 能用 Google 的人白填一张表。两条路必须同时看得见。
 *
 * 成功后后端已经写好登录 cookie，直接进 /library —— 本地标记的迁移询问
 * 由 <RequireAuth> 在进入已登录区域时弹出，这里不管。
 *
 * 验证码一进页面就出现（和登录页不同：登录是连错 3 次才要）。它挡的是脚本批量注册，
 * 限流按 IP 算，换代理就绕过去了。一张图只能提交一次，所以任何失败之后都换新图。
 */

import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ApiError, getCaptcha, register, type CaptchaDto } from '../api/client'
import { GoogleButton, useGoogleAvailable } from '../components/GoogleSignIn'
import { resetGuestImportDismissal } from '../lib/guestStorage'
import '../styles/login.css'

const MIN_PASSWORD = 8

type RegisterError = { kind: 'exists' } | { kind: 'text'; text: string }

function errorFor(err: unknown): RegisterError {
  if (!(err instanceof ApiError)) return { kind: 'text', text: '连不上服务器，稍后再试。' }
  if (err.status === 400) return { kind: 'text', text: '验证码不对，换了一张新的，再输一次。' }
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
  const [captcha, setCaptcha] = useState<CaptchaDto | null>(null)
  const [captchaAnswer, setCaptchaAnswer] = useState('')

  const refreshCaptcha = useCallback(async () => {
    setCaptchaAnswer('')
    try {
      setCaptcha(await getCaptcha())
    } catch {
      // 取图被限流或断网：留一个「点击加载」，不挡住整张表
      setCaptcha(null)
    }
  }, [])

  useEffect(() => {
    void refreshCaptcha()
  }, [refreshCaptcha])

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
    if (!captcha || !captchaAnswer.trim()) {
      setError({ kind: 'text', text: '先填一下验证码。' })
      return
    }

    setSubmitting(true)
    setError(null)
    try {
      await register({
        email: email.trim(),
        password,
        captchaId: captcha.id,
        captchaAnswer: captchaAnswer.trim(),
      })
      resetGuestImportDismissal()
      navigate('/library', { replace: true })
    } catch (err) {
      setError(errorFor(err))
      setSubmitting(false)
      // 这张图已经被后端作废了（答对答错都是），不换的话下一次必然 400
      void refreshCaptcha()
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

            <div className="field">
              验证码
              <div className="captcha-row">
                {captcha ? (
                  <button
                    type="button"
                    className="captcha-image"
                    onClick={refreshCaptcha}
                    title="点击换一张"
                    aria-label="验证码图片，点击换一张"
                    dangerouslySetInnerHTML={{ __html: captcha.svg }}
                  />
                ) : (
                  <button type="button" className="captcha-image is-empty" onClick={refreshCaptcha}>
                    点击加载
                  </button>
                )}
                <input
                  className="captcha-input"
                  value={captchaAnswer}
                  maxLength={8}
                  autoComplete="off"
                  spellCheck={false}
                  aria-label="验证码"
                  onChange={(e) => setCaptchaAnswer(e.target.value)}
                />
              </div>
              <span className="captcha-hint">不区分大小写。看不清就点图片换一张。</span>
            </div>

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
        <span aria-hidden="true"> · </span>
        <Link to="/privacy">注册前可以先看隐私说明：存什么、存多久</Link>
      </p>
    </div>
  )
}
