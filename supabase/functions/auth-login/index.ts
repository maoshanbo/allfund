// supabase/functions/auth-login/index.ts
// 邮箱密码登录 Edge Function（2026-09-09）
// 部署：supabase functions deploy auth-login --no-verify-jwt
//
// 目的：在 Supabase 自身网络内调 GoTrue /auth/v1/token，
// 避开 sb-proxy→supabase.co token 端点被网关掐 504 的链路卡死。
// 前端经 sb-proxy 转发到本函数（不能浏览器直连 supabase.co，被 GFW 拦）。

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.105.4'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || 'https://tqhtegazxykkqfcpejky.supabase.co'
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') || 'sb_publishable_iFtMcvav774gqF28gGYQVw_QMmuS-z3'

serve(async (req) => {
  // CORS（前端 fetch 直接打到 dachu.me 同源 sb-proxy，理论上不需 CORS；
  // 但保留以防有人直连 supabase.co 调试）
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey',
      },
    })
  }

  if (req.method !== 'POST') {
    return json({ error: { message: 'Method not allowed', status: 405, name: 'AuthApiError' } }, 405)
  }

  let body
  try {
    body = await req.json()
  } catch (_) {
    return json({ error: { message: 'Invalid JSON body', status: 400, name: 'AuthApiError' } }, 400)
  }

  const { email, password } = body || {}
  if (!email || !password) {
    return json({ error: { message: 'email and password required', status: 400, name: 'AuthApiError' } }, 400)
  }

  // 用 supabase-js 在 Deno 内调 signInWithPassword
  const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const t0 = Date.now()
  try {
    const { data, error } = await sb.auth.signInWithPassword({ email, password })
    const dt = Date.now() - t0
    console.log(`[auth-login] ${email} ${dt}ms ok=${!!data?.access_token} err=${error?.name}:${error?.message}`)
    if (error) {
      return json({
        error: {
          message: error.message,
          status: error.status || 400,
          name: error.name || 'AuthApiError',
          code: error.code,
        },
      }, error.status || 400)
    }
    return json({
      access_token: data.session?.access_token,
      refresh_token: data.session?.refresh_token,
      expires_in: data.session?.expires_in,
      expires_at: data.session?.expires_at,
      token_type: data.session?.token_type || 'bearer',
      user: data.user,
    })
  } catch (e) {
    const dt = Date.now() - t0
    console.error(`[auth-login] ${email} ${dt}ms THREW:`, e?.name, e?.message, e?.stack)
    return json({
      error: {
        message: (e && e.message) ? String(e.message) : 'unknown error',
        status: (e && e.status) ? e.status : 500,
        name: (e && e.name) ? e.name : 'AuthRetryableFetchError',
      },
    }, 500)
  }
})

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  })
}
