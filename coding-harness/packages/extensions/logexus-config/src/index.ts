/**
 * Logexus 专属 API 接口：运行时注入 DeepSeek 凭据与地址（不写 credentials.yaml、不经进程 env）。
 *
 * POST /api/logexus/config  body: { apiKey?, apiUrl?, model?, provider? }
 * - apiKey  -> setRuntimeDeepSeekConfig(apiKey)  （进程内存，请求时用于 Authorization）
 * - apiUrl  -> 去 /chat/completions 尾部后作为 deepseek baseURL（运行时覆盖）
 * - model/provider 当前仅接受记录，后续可接 agentDefaultModel
 */

import type { Context } from '@deepseek-ai/cordis'
import { setRuntimeDeepSeekConfig } from '@deepseek-ai/dsh-llm-deepseek'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { IncomingMessage, ServerResponse } from 'node:http'

interface LogexusConfig {
  path: string
}

/** 读取请求体并将 deepseek 凭据/地址写入运行时（进程内存，不落盘不经 env）。 */
function handleConfig(req: IncomingMessage, res: ServerResponse): void {
  if (req.method !== 'POST') {
    res.writeHead(405, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: 'method not allowed' }))
    return
  }
  let body = ''
  req.on('data', (chunk) => { body += String(chunk) })
  req.on('end', () => {
    try {
      const json = JSON.parse(body) as { apiKey?: string; apiUrl?: string; model?: string; provider?: string }
      // apiUrl -> baseURL：去掉 /chat/completions（llm-deepseek 会自行追加）
      const baseURL = (json.apiUrl ?? '')
        .replace(/\/+$/u, '')
        .replace(/\/chat\/completions$/u, '')
      setRuntimeDeepSeekConfig(json.apiKey, baseURL.length > 0 ? baseURL : undefined)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, model: json.model ?? null, provider: json.provider ?? null }))
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: 'bad json body' }))
    }
  })
}

/** Activate the webServer Context merge used below (cordis requires inject). */
export const inject = ['webServer']

export function apply(ctx: Context, config: LogexusConfig): void {
  const route = {
    kind: 'exact' as const,
    path: config.path,
    handler: (req: IncomingMessage, res: ServerResponse) => handleConfig(req, res),
  }
  ctx.effect(() => ctx.webServer.register(route), `logexus-config: ${config.path}`)
}
