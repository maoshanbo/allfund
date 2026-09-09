/**
 * Supabase Edge Function — auth-login（auth 登录代理，绕开 supabase 网关对外部 IP 的限流）
 *
 * 背景：
 *   EdgeOne Pages overseas 的函数出口是数据中心 IP，从这里代理 supabase auth/v1/token
 *   会被 supabase sb-gateway 在 5~6s 后掐 504 `{"message":"Gateway Timeout"}`（supabase-js
 *   把它包装为 `AuthRetryableFetchError: "{}"`，前端无法区分到底是"账号密码错"还是"网关抽"）。
 *
 *   本函数部署在 supabase 自身网络（新加坡 Deno runtime），用 anon key 在本网络内调
 *   supabase auth 验证邮箱/密码，不经过受掐的外部入口。验证成功后把 access/refresh
 *   token 原样回给浏览器，前端用 supabase.auth.setSession 写入存储，对 RLS 透明。
 *
 * 安全：
 *   - 本函数不存储任何密钥；anon key 本身就是公开的（前端用同一个）
 *   - 不存、不转发密码原文到任何第三方
 *   - 返给前端的 access_token JWT 是 supabase 真实签发的，与正常 signInWithPassword 等价
 *
 * 部署：
 *   supabase functions deploy auth-login --no-verify-jwt
 *
 * 调用（POST）：
 *   /functions/v1/auth-login
 *   body: { "email": "...", "password": "..." }
 *
 * 成功返（200）：
 *   { access_token, refresh_token, expires_in, expires_at, token_type, user: {...} }
 *
 * 失败返（400/401/...）：
 *   { error: { message, status, code } }
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.105.4'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || 'https://tqhtegazxykkqfcpejky.supabase.co'
const SUPABASE_ANON_KEY =
  Deno.env.get('SUPABASE_ANON_KEY') || 'sb_publishable_iFtMcvav774gqF28gGYQVw_QMmuS-z3'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Max-Age': '86400',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }
  if (req.method !== 'POST') {
    return json({ error: { message: 'method not allowed' } }, 405)
  }

  let body: { email?: string; password?: string } | null = null
  try {
    body = await req.json()
  } catch (_) {
    return json({ error: { message: 'invalid json body' } }, 400)
  }

  const email = (body?.email || '').trim()
  const password = body?.password || ''
  if (!email || !password) {
    return json({ error: { message: 'missing email or password' } }, 400)
  }

  // 在 supabase 自身网络内（不被 sb-gateway 掐）用 anon key 调 auth 验证密码
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: fetch.bind(globalThis) },
  })

  const t0 = Date.now()
  const { data, error } = await supabase.auth.signInWithPassword({ email, password })
  const dt = Date.now() - t0

  if (error) {
    console.log(`[auth-login] fail email=${email} status=${error.status ?? 'n/a'} msg=${error.message} (${dt}ms)`)
    return json(
      {
        error: {
          message: error.message,
          status: error.status,
          code: error.code,
          name: error.name,
        },
      },
      error.status && error.status >= 400 ? error.status : 401
    )
  }

  if (!data?.session) {
    return json({ error: { message: 'no session returned' } }, 500)
  }

  console.log(`[auth-login] ok email=${email} user=${data.user?.id} (${dt}ms)`)
  return json(
    {
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
      expires_in: data.session.expires_in,
      expires_at: data.session.expires_at,
      token_type: data.session.token_type,
      user: data.user,
    },
    200
  )
})

function json(payload: unknown, status: number) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}
