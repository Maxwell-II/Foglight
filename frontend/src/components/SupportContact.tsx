/**
 * 人工联系方式。/forgot 和 /privacy 共用，值在 lib/site.ts 的 SUPPORT_CONTACT。
 *
 * 空字符串 = 还没定：明说「即将公布」，不摆一个点了没反应的链接。
 */

import { SUPPORT_CONTACT } from '../lib/site'

export default function SupportContact({ subject }: { subject: string }) {
  if (!SUPPORT_CONTACT) return <strong>联系方式即将公布。</strong>
  if (SUPPORT_CONTACT.includes('@')) {
    return (
      <a href={`mailto:${SUPPORT_CONTACT}?subject=${encodeURIComponent(subject)}`}>
        {SUPPORT_CONTACT}
      </a>
    )
  }
  return <strong>{SUPPORT_CONTACT}</strong>
}
