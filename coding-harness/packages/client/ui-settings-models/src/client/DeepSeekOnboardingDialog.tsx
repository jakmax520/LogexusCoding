/**
 * Official-DeepSeek first-run step. Logexus 屏蔽「配置 API Key」onboarding 弹窗：
 * 不渲染任何内容，并立即 complete() 推进 onboarding 流程，避免空步骤卡死。
 * 保留组件签名（settings.onboarding 槽位仍注册，index.ts 的类型引用保持不变）。
 */

import { useEffect } from 'react'
import type { ReactNode } from 'react'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ModelsSettingsState, ModelsSettingsStore, ModelsWire } from './store.ts'
import type { SettingsSchemaOperations } from './schema-operations.ts'
import type { en } from './locales.ts'

/** Registration-side dependencies of {@link DeepSeekOnboardingDialog}. */
export interface DeepSeekOnboardingInjected {
  hooks: {
    /** Shared Models-page join state, bound by the slot renderer. */
    models: SnapshotStore<ModelsSettingsState>
  }
  /** Shared Models-page join controller. */
  controller: ModelsSettingsStore
  /** Existing wire face reused by the Models credential editor. */
  api: ModelsWire
  /** Settings schema and immutable path callbacks. */
  schema: SettingsSchemaOperations
  /** Feature copy. */
  t: (key: keyof typeof en) => string
}

/** Slot owner props plus the feature's injected dependencies. */
export type DeepSeekOnboardingDialogProps =
  PropsRuntime<'settings.onboarding'> & InjectFace<DeepSeekOnboardingInjected>

/**
 * 「配置 API Key」onboarding 已按需求屏蔽：不渲染，挂载即 complete() 推进流程。
 * @returns 始终 null。
 */
export function DeepSeekOnboardingDialog({ complete }: DeepSeekOnboardingDialogProps): ReactNode {
  useEffect(() => { complete() }, [complete])
  return null
}
