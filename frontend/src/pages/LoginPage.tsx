/**
 * 登录页（Wave 3 A2）。
 *
 * 进步式挑战：验证码**一开始不显示**，只有后端说 needsCaptcha 才出现
 * （连续失败 3 次之后）。他自己登录时永远见不到它 —— 让本人天天付出成本、
 * 让攻击者几乎不付出成本，是常见的设计错误（docs/work-packets-wave3.md §6）。
 */

import { useEffect, useState, type FormEvent } from 'react'
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { ApiError, getCaptcha, login, type CaptchaDto, type LoginResult } from '../api/client'
import { GoogleButton, useGoogleAvailable } from '../components/GoogleSignIn'
import { formatCountdown } from '../lib/auth'
import { resetGuestImportDismissal } from '../lib/guestStorage'
import '../styles/login.css'

/** Google 回调失败时后端把人送回 /login?error=…。只认这两个值，别的原样忽略 */
const GOOGLE_ERRORS: Record<string, string> = {
  google: 'Google 登录没有完成。可以再试一次，或者用邮箱登录。',
  google_unavailable: 'Google 登录暂时用不了，请先用邮箱登录。',
}

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
  const from = (location.state as LoginNavState | null)?.from ?? '/library'
  const [searchParams] = useSearchParams()
  const googleError = GOOGLE_ERRORS[searchParams.get('error') ?? ''] ?? null
  const googleAvailable = useGoogleAvailable()

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
        // 同一个标签页里退出再登录也算「下次登录」：上次点过「暂不」的本地标记要再问一次
        resetGuestImportDismissal()
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
      // 429 是按 IP 的全局上限（跨账号累计失败），和单账号的锁定是两回事 ——
      // 它不走 LoginOut，没有 lockedForSeconds 可显示。
      setError(
        err instanceof ApiError
          ? err.status === 429
            ? '尝试过于频繁，稍后再试。'
            : `登录请求失败（${err.status}）。`
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
      <p className="dim login-sub">登录后，阅读记录存在账号里，换设备也在。</p>

      {/* 表单自己的错误优先：提交过一次之后，地址栏里那个 Google 错误已经是旧闻了 */}
      {(error ?? googleError) && (
        <div className="error-banner" role="alert">
          {error ?? googleError}
        </div>
      )}

      <div className="login-card">
        {googleAvailable && (
          <>
            <GoogleButton />
            <div className="auth-or" aria-hidden="true">
              或者用邮箱
            </div>
          </>
        )}

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

        <div className="auth-links">
          <Link to="/forgot">忘记密码</Link>
          <span>
            没有账号？<Link to="/register">注册</Link>
          </span>
        </div>
      </div>

      <p className="auth-footnote">
        不登录也能读：<Link to="/">回首页挑一篇</Link>
      </p>
    </div>
  )
}
