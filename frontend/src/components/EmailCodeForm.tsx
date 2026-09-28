/**
 * 注册 / 找回密码共用的两步表单（2026-09-28）：
 *
 *   ① 邮箱 + 图形验证码 →「发送验证码」
 *   ② 邮件里的 6 位数字 + 密码 → 注册 / 重置，成功即登录
 *
 * 两个页面只有文案和接口不同，所以用 mode 分支，而不是各写一份一样的状态机。
 * 页面外壳（标题、Google 按钮、页脚链接）留在各自的页面里。
 *
 * 图形验证码提交一次就作废（答对答错都是），所以第①步任何失败之后都换一张新图。
 * 「重新发送」回到第①步重新认图：后端每发一封都要过图形验证码。
 */

import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import {
  ApiError,
  apiDetail,
  getCaptcha,
  register,
  resetPassword,
  sendRegisterCode,
  sendResetCode,
  type CaptchaDto,
} from '../api/client'
import SupportContact from './SupportContact'

export const MIN_PASSWORD = 8

type Mode = 'register' | 'reset'

const TEXT = {
  register: {
    send: '发送验证码',
    submit: '注册',
    submitting: '注册中…',
    passwordLabel: '设置密码',
    passwordHint: `至少 ${MIN_PASSWORD} 位。忘了可以用邮箱找回。`,
  },
  reset: {
    send: '发送验证码',
    submit: '重置密码并登录',
    submitting: '重置中…',
    passwordLabel: '新密码',
    passwordHint: `至少 ${MIN_PASSWORD} 位。改完之后，其他设备上的登录会失效。`,
  },
} as const

function unreachable(): ReactNode {
  return '连不上服务器，稍后再试。'
}

function sendError(err: unknown, mode: Mode): ReactNode {
  if (!(err instanceof ApiError)) return unreachable()
  switch (err.status) {
    case 400:
      return '图形验证码不对，换了一张新的，再输一次。'
    case 409:
      return (
        <>
          该邮箱已注册。<Link to="/login">去登录</Link>
          <span aria-hidden="true"> · </span>
          <Link to="/forgot">忘记密码</Link>
        </>
      )
    case 422:
      return '邮箱格式不对。'
    case 429:
      return apiDetail(err) ?? '发送太频繁，稍后再试。'
    case 502:
      return '邮件没发出去，稍后再试。'
    case 503:
      return mode === 'reset' ? (
        <>
          邮件验证码暂时用不了。着急的话联系：
          <SupportContact subject="Foglight 重置密码" />
        </>
      ) : (
        '邮件验证码暂时用不了，稍后再试。'
      )
    default:
      return `请求失败（${err.status}）。`
  }
}

function submitError(err: unknown): ReactNode {
  if (!(err instanceof ApiError)) return unreachable()
  switch (err.status) {
    case 400:
      return '邮件验证码不对或已过期。同一封信输错 5 次会作废，那样需要重新发送。'
    case 409:
      return (
        <>
          该邮箱已注册。<Link to="/login">去登录</Link>
        </>
      )
    case 422:
      return `密码至少 ${MIN_PASSWORD} 位。`
    default:
      return `请求失败（${err.status}）。`
  }
}

export default function EmailCodeForm({ mode, onDone }: { mode: Mode; onDone: () => void }) {
  const text = TEXT[mode]

  const [step, setStep] = useState<'send' | 'verify'>('send')
  const [email, setEmail] = useState('')
  const [captcha, setCaptcha] = useState<CaptchaDto | null>(null)
  const [captchaAnswer, setCaptchaAnswer] = useState('')
  const [code, setCode] = useState('')
  const [password, setPassword] = useState('')
  const [cooldown, setCooldown] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<ReactNode>(null)

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
    if (step === 'send') void refreshCaptcha()
  }, [step, refreshCaptcha])

  // 重发倒计时。每秒减一，到 0 停
  useEffect(() => {
    if (cooldown <= 0) return
    const timer = window.setTimeout(() => setCooldown((s) => s - 1), 1000)
    return () => window.clearTimeout(timer)
  }, [cooldown])

  const onSend = async (e: FormEvent) => {
    e.preventDefault()
    if (busy) return
    if (!email.trim()) {
      setError('先填邮箱。')
      return
    }
    if (!captcha || !captchaAnswer.trim()) {
      setError('先填一下图形验证码。')
      return
    }
    setBusy(true)
    setError(null)
    const payload = { email: email.trim(), captchaId: captcha.id, captchaAnswer: captchaAnswer.trim() }
    try {
      const resp = await (mode === 'register' ? sendRegisterCode(payload) : sendResetCode(payload))
      setCooldown(resp.cooldownSeconds)
      setCode('')
      setStep('verify')
    } catch (err) {
      setError(sendError(err, mode))
      void refreshCaptcha()
    } finally {
      setBusy(false)
    }
  }

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (busy) return
    if (!code.trim()) {
      setError('先填邮件里的验证码。')
      return
    }
    // 前端先挡一次只是省一个来回，真正的校验在后端（422）
    if (password.length < MIN_PASSWORD) {
      setError(`密码至少 ${MIN_PASSWORD} 位。`)
      return
    }
    setBusy(true)
    setError(null)
    try {
      if (mode === 'register') {
        await register({ email: email.trim(), code: code.trim(), password })
      } else {
        await resetPassword({ email: email.trim(), code: code.trim(), newPassword: password })
      }
      onDone()
    } catch (err) {
      setError(submitError(err))
      setBusy(false)
    }
  }

  const backToSend = () => {
    setError(null)
    setStep('send')
  }

  return (
    <>
      {error && (
        <div className="error-banner" role="alert">
          {error}
        </div>
      )}

      {step === 'send' ? (
        <form className="import-form login-form" onSubmit={onSend}>
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

          <div className="field">
            图形验证码
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
                aria-label="图形验证码"
                onChange={(e) => setCaptchaAnswer(e.target.value)}
              />
            </div>
            <span className="captcha-hint">不区分大小写。看不清就点图片换一张。</span>
          </div>

          <button className="btn-primary login-submit" type="submit" disabled={busy}>
            {busy ? '发送中…' : text.send}
          </button>
        </form>
      ) : (
        <form className="import-form login-form" onSubmit={onSubmit}>
          <p className="code-sent" role="status">
            {mode === 'register' ? (
              <>
                验证码已发到 <strong>{email.trim()}</strong>，10 分钟内有效。
              </>
            ) : (
              <>
                如果 <strong>{email.trim()}</strong> 注册过，验证码已经发过去了，10 分钟内有效。
              </>
            )}
            <br />
            几分钟没收到的话，看一下垃圾邮件。
          </p>

          <label className="field">
            邮件验证码
            <input
              className="code-input"
              value={code}
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              autoFocus
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
            />
          </label>

          <label className="field">
            {text.passwordLabel}
            <input
              type="password"
              value={password}
              autoComplete="new-password"
              minLength={MIN_PASSWORD}
              onChange={(e) => setPassword(e.target.value)}
            />
            <span className="field__hint">{text.passwordHint}</span>
          </label>

          <button className="btn-primary login-submit" type="submit" disabled={busy}>
            {busy ? text.submitting : text.submit}
          </button>

          <button type="button" className="code-resend" onClick={backToSend} disabled={cooldown > 0}>
            {cooldown > 0 ? `没收到？${cooldown} 秒后可以重新发送` : '没收到？重新发送 / 换个邮箱'}
          </button>
        </form>
      )}
    </>
  )
}
