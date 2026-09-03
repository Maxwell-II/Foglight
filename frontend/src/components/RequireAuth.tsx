/**
 * 路由守卫（Wave 3 A2）。自包含：不改 App.tsx（那是书籍线的文件），
 * 由规划方在合并时把需要保护的路由包进来。
 *
 *   <RequireAuth><LibraryPage /></RequireAuth>
 */

import { useEffect, useState, type ReactNode } from 'react'
import { Navigate, useLocation, useNavigate } from 'react-router-dom'
import { LOGIN_PATH, probeAuth, signOut, type AuthStatus } from '../lib/auth'
import AppActions from './AppActions'
import '../styles/login.css'

/** 退出入口。自身不定位 —— 位置由包着它的 <AppActions> 决定。 */
function LogoutButton() {
  const navigate = useNavigate()
  const [leaving, setLeaving] = useState(false)

  const onClick = async () => {
    setLeaving(true)
    await signOut()
    navigate(LOGIN_PATH, { replace: true })
  }

  return (
    <button
      className="logout-btn"
      type="button"
      onClick={onClick}
      disabled={leaving}
      title="退出登录"
    >
      退出
    </button>
  )
}

export default function RequireAuth({ children }: { children: ReactNode }) {
  const location = useLocation()
  const [status, setStatus] = useState<AuthStatus>('checking')

  useEffect(() => {
    let cancelled = false
    probeAuth().then((probe) => {
      if (!cancelled) setStatus(probe.status)
    })
    return () => {
      cancelled = true
    }
    // 只在挂载时问一次：守卫包在路由外层，页面之间切换不会重挂，
    // 每次切页都打一次 /auth/me 是白花钱。会话失效由各接口自己的 401 暴露。
  }, [])

  if (status === 'checking') {
    // ⚠️ 这一支是三态的全部意义所在：既不渲染内容，**也不渲染登录页**。
    //    渲染登录页的话，硬刷新首页会闪一下登录表单再跳回来。
    // 主题按钮照常渲染：它和登录状态无关，探测这几十毫秒里让它闪掉才难看。
    return (
      <>
        <AppActions />
        <div className="auth-checking" role="status" aria-busy="true" aria-label="正在确认登录状态" />
      </>
    )
  }

  if (status === 'anonymous') {
    // 记住原地址，登录成功后跳回去。用字符串而不是整个 location 对象 ——
    // history.state 要能被结构化克隆。
    return (
      <Navigate to={LOGIN_PATH} state={{ from: location.pathname + location.search }} replace />
    )
  }

  return (
    <>
      <AppActions>
        <LogoutButton />
      </AppActions>
      {children}
    </>
  )
}
