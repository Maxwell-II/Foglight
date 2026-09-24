/**
 * 游客列表的状态列：这台浏览器里读过没有、标了几处。数据来自 localStorage（guestStorage）。
 * 落地页的推荐和 /explore 共用。
 */

import { readGuestRecord } from '../lib/guestStorage'

export default function GuestRowState({ articleId }: { articleId: number }) {
  const record = readGuestRecord(articleId)
  if (record?.status === 'finished') {
    return <span className="list-row__state">读过{record.marks.length > 0 && ` · 标了 ${record.marks.length} 处`}</span>
  }
  if (record && record.marks.length > 0) {
    return (
      <span className="list-row__state is-reading">
        <span className="lamp lamp--sm" aria-hidden="true" />
        在读 · 标了 {record.marks.length} 处
      </span>
    )
  }
  return <span className="list-row__state is-unread">未读</span>
}
