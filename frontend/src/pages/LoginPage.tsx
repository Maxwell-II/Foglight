/**
 * 登录页（Wave 3 A2）。
 *
 * 进步式挑战：验证码**一开始不显示**，只有后端说 needsCaptcha 才出现
 * （连续失败 3 次之后）。他自己登录时永远见不到它 —— 让本人天天付出成本、
 * 让攻击者几乎不付出成本，是常见的设计错误（docs/work-packets-wave3.md §6）。
 */

import { useEffect, useState, type FormEvent } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { ApiError, getCaptcha, login, type CaptchaDto, type LoginResult } from '../api/client'
import { formatCountdown } from '../lib/auth'
import '../styles/login.css'

interface LoginNavState {
  from?: string
}

function failureMessage(result: LoginResult): string {
  if (result.lockedForSeconds > 0) {
    return `失败次数太多，账号已锁定，${formatCountdown(result.lockedForSeconds)} 后再试。`
  }
  if (result.needsCaptcha) {
    // 越过阈值之后，"密码错"和"验证码错"后端一律回同一个形状，
    // 所以这句话不能说死是哪个错了。
    return '登录没通过。请连同下面的验证码一起重试。'
  }
  return '邮箱或密码不对。'
}

export default function LoginPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const from = (location.state as LoginNavState | null)?.from ?? '/'

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [needsCaptcha, setNeedsCaptcha] = useState(false)
  const [captcha, setCaptcha] = useState<CaptchaDto | null>(null)
  const [captchaAnswer, setCaptchaAnswer] = useState('')
  const [lockedFor, setLockedFor] = useState(0)

  // 锁定倒计时。每次只挂一个 setTimeout，不留常驻 interval。
  useEffect(() => {
    if (lockedFor <= 0) return
    const timer = window.setTimeout(() => setLockedFor((s) => Math.max(0, s - 1)), 1000)
    return () => window.clearTimeout(timer)
  }, [lockedFor])

  const refreshCaptcha = async () => {
    try {
      setCaptcha(await getCaptcha())
      setCaptchaAnswer('')
    } catch {
      setCaptcha(null)
    }
  }

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (submitting || lockedFor > 0) return
    if (!email.trim() || !password) {
      setError('邮箱和密码都要填。')
      return
    }

    setSubmitting(true)
    setError(null)
    try {
      const result = await login({
        email: email.trim(),
        password,
        captchaId: needsCaptcha ? captcha?.id : undefined,
        captchaAnswer: needsCaptcha ? captchaAnswer.trim() : undefined,
      })

      if (result.ok) {
        navigate(from, { replace: true })
        return
      }

      setNeedsCaptcha(result.needsCaptcha)
      setLockedFor(result.lockedForSeconds)
      setError(failureMessage(result))
      // 验证码是一次性的，用过就作废 —— 无论对错都得换一张，
      // 不换的话下一次提交必定再失败一次，看上去像"密码明明是对的"。
      if (result.needsCaptcha) await refreshCaptcha()
    } catch (err) {
      setError(
        err instanceof ApiError
          ? `登录请求失败（${err.status}）。`
          : '连不上服务器，稍后再试。',
      )
    } finally {
      setSubmitting(false)
    }
  }

  const locked = lockedFor > 0

  return (
    <div className="wrap login-wrap">
      <div className="brand">Foglight</div>

      <h1 className="title login-title" style={{ marginTop: 32 }}>登录</h1>
      <p className="dim login-sub">这是私人阅读器，账号由命令行建，不开放注册。</p>

      {error && (
        <div className="error-banner" role="alert">
          {error}
        </div>
      )}

      <div className="login-card">
        <form className="import-form login-form" onSubmit={onSubmit}>
          <label className="field">
            邮箱
            <input
              type="email"
              value={email}
              autoComplete="username"
              autoFocus
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>

          <label className="field">
            密码
            <input
              type="password"
              value={password}
              autoComplete="current-password"
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>

          {needsCaptcha && (
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
                  onChange={(e) => setCaptchaAnswer(e.target.value)}
                />
              </div>
              <span className="captcha-hint">不区分大小写。看不清就点图片换一张。</span>
            </div>
          )}

          <button className="btn-primary login-submit" type="submit" disabled={submitting || locked}>
            {locked ? `已锁定 ${formatCountdown(lockedFor)}` : submitting ? '登录中…' : '登录'}
          </button>
        </form>
      </div>
    </div>
  )
}
