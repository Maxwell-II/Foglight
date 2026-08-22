/**
 * 登录态的前端小工具（Wave 3 A2）。
 *
 * 只放"判断当前是不是登录着"和"退出"这两件事，网络细节全在 api/client.ts ——
 * 那个文件是 §1.14 的冻结契约，本包只消费，不改一个字。
 */

import { ApiError, getMe, logout, type MeDto } from '../api/client'

/**
 * ⚠️ 必须是三态，不能写成布尔（§A2）。
 *
 * 布尔的话，getMe() 还没回来时只能默认"未登录"，于是每次硬刷新首屏都会
 * **闪一下登录页** —— 而他每天打开都会看到。和 W3 那个白闪是同一类问题：
 * "还不知道" 和 "知道是否" 是两回事，把它们挤进一个布尔就必然丢信息。
 */
export type AuthStatus = 'checking' | 'authed' | 'anonymous'

export type SettledAuthStatus = Exclude<AuthStatus, 'checking'>

export interface AuthProbe {
  status: SettledAuthStatus
  user: MeDto | null
  /** 非 401 的失败（后端挂了 / 断网）才有值，用来在登录页上解释为什么被弹回来 */
  error: string | null
}

export const LOGIN_PATH = '/login'

/** 问一次后端"我是谁"。401 → 匿名；其他错误也当匿名，但带上原因。 */
export async function probeAuth(): Promise<AuthProbe> {
  try {
    const user = await getMe()
    return { status: 'authed', user, error: null }
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      return { status: 'anonymous', user: null, error: null }
    }
    // 后端 500 或断网时也走登录页：这时候页面里什么都加载不出来，
    // 停在登录页至少能看到一句人话，而不是一片空白加满屏红字。
    return {
      status: 'anonymous',
      user: null,
      error: err instanceof Error ? err.message : '连不上服务器。',
    }
  }
}

/** 退出。后端已经把"cookie 无效"也当成功（204），所以这里失败了也不必拦着用户走。 */
export async function signOut(): Promise<void> {
  try {
    await logout()
  } catch {
    // 无论如何都要让调用方跳登录页：退不出去比退出去危险
  }
}

/** 锁定倒计时 → mm:ss */
export function formatCountdown(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds))
  const mm = Math.floor(safe / 60)
  const ss = safe % 60
  return `${mm}:${String(ss).padStart(2, '0')}`
}
