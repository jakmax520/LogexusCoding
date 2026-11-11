/** Product-wide, versioned internal-testing notice. Logexus 屏蔽「内测声明」弹窗。 */

import { useEffect } from 'react'
import type { ReactNode } from 'react'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { WelcomeNoticeState, WelcomeNoticeStore } from './welcome-store.ts'
import type { en } from './locales.ts'

/** Registration-side dependencies of {@link WelcomeNotice}. */
export interface WelcomeNoticeInjected {
  hooks: {
    /** Durable or process-local acknowledgement state. */
    welcome: SnapshotStore<WelcomeNoticeState>
  }
  /** Welcome acknowledgement controller. */
  controller: WelcomeNoticeStore
  /** Onboarding copy. */
  t: (key: keyof typeof en) => string
}

/** Coordinator owner props plus this step's injected face. */
export type WelcomeNoticeProps =
  PropsRuntime<'settings.onboarding'> & InjectFace<WelcomeNoticeInjected>

/**
 * 内测声明弹窗已按需求移除：不渲染任何声明内容，并立即 complete() 推进 onboarding 流程，
 * 避免空步骤卡死。保留组件签名（settings.onboarding 槽位仍注册）。
 * @returns 始终 null。
 */
export function WelcomeNotice({ complete }: WelcomeNoticeProps): ReactNode {
  useEffect(() => { complete() }, [complete])
  return null
}
