<template>
  <div class="login-overlay" :class="{ 'login-overlay--wall': wall }" @click.self="!wall && $emit('close')">
    <div class="login-dialog" role="dialog" aria-modal="true" aria-label="登录注册">
      <button v-if="!wall" class="login-close" @click="$emit('close')" aria-label="关闭">&times;</button>

      <div class="login-title">登录</div>

      <!-- Tab 切换 -->
      <div class="login-tabs">
        <span class="login-tab" :class="{ active: mode === 'signin' || mode === 'reset' }" @click="mode = 'signin'">登录</span>
        <span class="login-tab" :class="{ active: mode === 'signup' }" @click="mode = 'signup'; accType = 'phone'">注册（手机号）</span>
      </div>

      <!-- 账号类型切换：仅登录时可选邮箱/手机号；注册仅限手机号 -->
      <div class="login-acctype" v-if="mode === 'signin'">
        <button type="button" class="acctype-btn" :class="{ active: accType === 'email' }" @click="accType = 'email'">邮箱</button>
        <button type="button" class="acctype-btn" :class="{ active: accType === 'phone' }" @click="accType = 'phone'">手机号</button>
      </div>
      <p class="login-hint" v-else>新用户请使用手机号注册，自主设定密码（无需短信验证码），注册后申请访问权限。</p>

      <!-- 表单 -->
      <div class="login-form">
        <!-- 重置密码模式 -->
        <template v-if="mode === 'reset'">
          <p class="login-hint">输入注册时使用的邮箱或手机号，我们将发送密码重置链接到您的邮箱。</p>

          <div class="login-acctype">
            <button type="button" class="acctype-btn" :class="{ active: accType === 'email' }" @click="accType = 'email'">邮箱</button>
            <button type="button" class="acctype-btn" :class="{ active: accType === 'phone' }" @click="accType = 'phone'">手机号</button>
          </div>

          <label class="login-label" :for="accType === 'email' ? 'reset-email' : 'reset-phone'">
            {{ accType === 'email' ? '邮箱地址' : '手机号' }}
          </label>
          <input
            :id="accType === 'email' ? 'reset-email' : 'reset-phone'"
            class="login-input"
            :type="accType === 'email' ? 'email' : 'tel'"
            v-model="account"
            :placeholder="accType === 'email' ? 'you@example.com' : '11 位手机号'"
            @keyup.enter="sendReset"
          />

          <div class="login-error" v-if="error">{{ error }}</div>
          <div class="login-success" v-if="success">{{ success }}</div>

          <button class="login-submit" :disabled="loading" @click="sendReset">
            {{ loading ? '发送中...' : '发送重置链接' }}
          </button>

          <button class="login-link-btn" type="button" @click="backToSignin">← 返回登录</button>
        </template>

        <!-- 登录 / 注册模式 -->
        <template v-else>
        <label class="login-label" :for="accType === 'email' ? 'login-email' : 'login-phone'">
          {{ accType === 'email' ? '邮箱地址' : '手机号' }}
        </label>
        <input
          :id="accType === 'email' ? 'login-email' : 'login-phone'"
          class="login-input"
          :type="accType === 'email' ? 'email' : 'tel'"
          v-model="account"
          :placeholder="accType === 'email' ? 'you@example.com' : '11 位手机号'"
          @keyup.enter="submit"
        />

        <label class="login-label" for="login-password">密码</label>
        <input
          id="login-password"
          class="login-input"
          type="password"
          v-model="password"
          placeholder="至少 6 位字符（注册时自设）"
          @keyup.enter="submit"
        />

        <div class="login-error" v-if="error">{{ error }}</div>
        <div class="login-success" v-if="success">{{ success }}</div>

        <!-- 忘记密码：仅登录模式显示 -->
        <button
          v-if="mode === 'signin'"
          class="login-forgot"
          type="button"
          @click="startReset"
        >忘记密码？</button>

        <button class="login-submit" :disabled="loading" @click="submit">
          <template v-if="loading">{{ loadingText }}</template>
          <template v-else>{{ mode === 'signup' ? '注册' : '登录' }}</template>
        </button>

        </template>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue'
import { supabase, rewriteSupabaseUrl, getSupabaseAnonKey } from '../api/supabase'
import { toast } from '../composables/useToast.js'
import { useAuth } from '../composables/useAuth.js'

const props = defineProps({
  // wall=true 时作为登录墙：全屏、不可关闭、无关闭按钮
  wall: { type: Boolean, default: false },
})

const emit = defineEmits(['close', 'logged-in'])
const { markLogin } = useAuth()

const mode = ref('signin')      // 'signin' | 'signup' | 'reset'
const accType = ref('email')    // 'email' | 'phone'
const account = ref('')
const password = ref('')
const loading = ref(false)
const loadingText = ref('处理中...')
const error = ref('')
const success = ref('')

// 手机号规范化：11 位大陆号补 +86；已带 + 的保留
function normalizePhone(v) {
  v = (v || '').replace(/[\s-]/g, '')
  if (v.startsWith('+')) return v
  if (v.startsWith('86') && v.length === 13) return '+' + v
  if (/^1\d{10}$/.test(v)) return '+86' + v
  return v
}

// 手机号 → 确定性合成邮箱（Supabase 手机号注册未开启，且需短信OTP，
// 故以合成邮箱承载「手机号+密码」身份，复用既有的邮件自动确认与邮箱权限体系）。
// 新账号使用 @dachu.user；历史账号为 @allfund.user，登录时按候选顺序逐一尝试以保证兼容。
function phoneCandidates(phone) {
  const p = normalizePhone(phone).replace(/^\+/, '')
  return [`${p}@dachu.user`, `${p}@allfund.user`]
}

async function submit() {
  error.value = ''
  success.value = ''
  const isPhone = accType.value === 'phone'
  const identifier = isPhone ? normalizePhone(account.value) : (account.value || '').trim()

  if (!identifier || !password.value) {
    error.value = isPhone ? '请填写手机号和密码' : '请填写邮箱和密码'
    return
  }
  if (isPhone) {
    if (!/^\+861\d{10}$/.test(identifier)) {
      error.value = '请输入有效的 11 位手机号'
      return
    }
  } else {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(identifier)) {
      error.value = '邮箱格式不正确'
      return
    }
  }
  if (password.value.length < 6) {
    error.value = '密码长度至少 6 位'
    return
  }

  loading.value = true
  loadingText.value = '验证中...'
  try {
    if (mode.value === 'signup') {
      if (isPhone) {
        // 历史账号可能落在 @allfund.user，先逐一尝试验证是否已注册
        let existing = false
        for (const email of phoneCandidates(identifier)) {
          const { error: e2 } = await withAuthTimeout(supabase.auth.signInWithPassword({ email, password: password.value }))
          if (!e2) { existing = true; break }
        }
        if (existing) {
          error.value = '该手机号已注册，请直接登录'
          mode.value = 'signin'
          return
        }
        const { data, error: err } = await supabase.auth.signUp({ email: phoneCandidates(identifier)[0], password: password.value })
        if (err) { error.value = translateError(err.message); return }
        if (data?.user?.identities?.length === 0) {
          error.value = '该手机号已注册，请直接登录'
          mode.value = 'signin'
          return
        }
        markLogin()
        if (data?.session) {
          toast('注册成功', 'success')
          emit('logged-in')
        } else {
          success.value = '注册成功！请直接登录。'
        }
      } else {
        const creds = { email: identifier, password: password.value }
        const { data, error: err } = await supabase.auth.signUp(creds)
        if (err) { error.value = translateError(err.message); return }
        if (data?.user?.identities?.length === 0) {
          error.value = '该邮箱已注册，请直接登录'
          mode.value = 'signin'
          return
        }
        markLogin()
        if (data?.session) {
          toast('注册成功', 'success')
          emit('logged-in')
        } else {
          success.value = '注册成功！请直接登录。'
        }
      }
    } else {
      if (isPhone) {
        // 新账号 @dachu.user，历史账号 @allfund.user，按候选顺序逐一登录
        // 邮箱和手机号登录都走 supabase Edge Function auth-login（绕开 sb-gateway 504 限流）
        let lastResult = null
        let ok = false
        for (const email of phoneCandidates(identifier)) {
          const result = await authLoginViaEdgeFunction(email, password.value)
          if (result.ok) { ok = true; break }
          lastResult = result
        }
        if (!ok) {
          error.value = translateError(lastResult?.message || '', { status: lastResult?.status, name: lastResult?.name })
          return
        }
      } else {
        // 邮箱登录优先走 supabase Edge Function auth-login（在 supabase 自身网络调 auth，
        // 绕开 EdgeOne overseas → supabase.co 跨网关 504 限流）。
        // Edge Function 内部用 anon key 调 signInWithPassword，返真实 access/refresh token，
        // 前端用 setSession 写入 —— 对 RLS 透明，等价于正常登录。
        try {
          const result = await authLoginViaEdgeFunction(identifier, password.value)
          if (!result.ok) {
            error.value = translateError(result.message || '', { status: result.status, name: result.name })
            return
          }
        } catch (e) {
          // Edge Function 调用本身失败（网络/网关）：回退到浏览器直连 supabase（碰运气）
          console.warn('[LoginDialog] auth-login Edge Function 失败，回退到 supabase 直连:', e)
          const { error: err } = await withAuthTimeout(
            supabase.auth.signInWithPassword({ email: identifier, password: password.value }),
            60000
          )
          if (err) {
            error.value = translateError(typeof err.message === 'string' ? err.message : '', err)
            return
          }
        }
      }
      markLogin()
      loadingText.value = '加载权限中...'
      toast('登录成功', 'success')
      emit('logged-in')
    }
  } catch (e) {
    // 超时（AbortError）/网络错 → 友好提示，避免无限"处理中…"
    const msg = (e && e.message) ? String(e.message) : String(e || '')
    console.error('[LoginDialog] 登录异常:', { name: e?.name, message: e?.message, code: e?.code, string: String(e) })
    if (msg.indexOf('aborted') !== -1 || msg.indexOf('timeout') !== -1) {
      error.value = '登录超时，请稍后重试'
    } else if (msg.indexOf('Failed to fetch') !== -1 || msg.indexOf('NetworkError') !== -1 || msg.indexOf('网络') !== -1) {
      error.value = '网络连接失败，请检查网络后重试'
    } else if (!msg || msg.length < 2) {
      error.value = '登录失败，请稍后重试'
    } else {
      error.value = '登录出错：' + msg
    }
  } finally {
    loading.value = false
    loadingText.value = '处理中...'
  }
}

// 给 Supabase Auth 请求加 60s 超时兜底：避免异常时前端无限"处理中…"。
function withAuthTimeout(promise, ms = 60000) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('登录服务响应超时 (timeout)')), ms)),
  ])
}

/**
 * 通过 supabase Edge Function `auth-login` 完成密码登录（绕开 sb-gateway 504 限流）。
 * 成功：拿到 access/refresh token 后调 supabase.auth.setSession，等价于直接 signInWithPassword。
 * 失败：返 { ok:false, message, status, name } 让上层走原 translateError 翻译。
 *
 * Edge Function URL：/functions/v1/auth-login，通过同域 sb-proxy 转发到 supabase 自身网络。
 * sb-proxy 对 supabase.co 域名的所有路径已自动改写到 /api/sb-proxy?path=<encodeURIComponent>。
 */
async function authLoginViaEdgeFunction(email, password) {
  const t0 = Date.now()
  // 必须经 sb-proxy 转发到 supabase 自身网络（Edge Function 在 supabase 内部运行，
  // 它到 supabase auth 同区域不被掐）。浏览器直连 supabase.co 在国内被 GFW 拦。
  const url = rewriteSupabaseUrl('https://tqhtegazxykkqfcpejky.supabase.co/functions/v1/auth-login')
  // Edge Function 端点要求 apikey header 识别项目归属（即便 --no-verify-jwt 也要）。
  // sb-proxy 透传该 header 到上游。
  const apikey = getSupabaseAnonKey()
  const headers = { 'Content-Type': 'application/json' }
  if (apikey) {
    headers['apikey'] = apikey
    headers['Authorization'] = `Bearer ${apikey}`
  }
  const resp = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ email, password }),
  })
  let body
  try {
    body = await resp.json()
  } catch (e) {
    return { ok: false, message: '{}', status: resp.status, name: 'AuthRetryableFetchError' }
  }
  const dt = Date.now() - t0
  console.log(`[auth-login Edge Function] ${resp.status} ${dt}ms`, body)
  if (!resp.ok) {
    return {
      ok: false,
      message: (body && body.error && body.error.message) || body?.message || '',
      status: (body && body.error && body.error.status) || resp.status,
      name: (body && body.error && body.error.name) || 'AuthApiError',
    }
  }
  // 成功：用 setSession 写入 supabase 客户端
  const { access_token, refresh_token } = body
  if (!access_token || !refresh_token) {
    return { ok: false, message: 'no tokens returned', status: 500, name: 'AuthApiError' }
  }
  const { error: setErr } = await supabase.auth.setSession({ access_token, refresh_token })
  if (setErr) {
    return {
      ok: false,
      message: typeof setErr.message === 'string' ? setErr.message : '',
      status: setErr.status,
      name: setErr.name,
    }
  }
  return { ok: true }
}

function translateError(msg, errObj) {
  // 防御：msg 为空/非字符串/纯空白/纯数字或 "{}" 等无意义串时统一兜底为人话
  let s = (typeof msg === 'string' ? msg : '').trim()
  // 关键：supabase-js v2 对 5xx 错误会把 body JSON 字面序列化为 "{}" 串给 err.message。
  // 仅看字符串无法分辨"账号密码错"与"网关 504 限流"。结合 err.name / err.status 二次判断：
  //   - AuthRetryableFetchError（name）→ 网络/网关层抽风
  //   - 5xx status → 上游服务异常
  // 这些情况都不是用户凭证问题，必须明确告知"服务不可用"而不是"账号或密码错"。
  if (errObj) {
    const name = errObj.name || ''
    const status = errObj.status
    if (name === 'AuthRetryableFetchError' || (typeof status === 'number' && status >= 500)) {
      return '登录服务暂时不可用，请稍后重试'
    }
  }
  if (!s || /^[\d\s{}]+$/.test(s)) return '登录失败，请检查账号密码或稍后重试'
  // 服务级错误（Supabase 网关 504/503/timeout 等），不是账号密码问题
  if (/timeout|gateway|unavailable|service unavailable/i.test(s)) return '登录服务暂时不可用，请稍后重试'
  const map = {
    'Invalid login credentials': '账号或密码错误',
    'Email not confirmed': '邮箱尚未确认，请直接尝试登录',
    'Phone not confirmed': '手机号尚未验证，请直接尝试登录',
    'User already registered': '该账号已注册，请直接登录',
    'Password should be at least 6 characters': '密码长度至少 6 位',
    'Unable to validate email address: invalid format': '邮箱格式不正确',
    'Unable to validate phone number: invalid format': '手机号格式不正确',
    'Phone auth is not enabled': '手机号注册未启用，请改用邮箱或联系管理员',
    'Signups not allowed for this method': '该注册方式未开启',
  }
  return map[s] || s
}

// ── 重置密码 ──
function startReset() {
  mode.value = 'reset'
  error.value = ''
  success.value = ''
  account.value = ''
}

function backToSignin() {
  mode.value = 'signin'
  error.value = ''
  success.value = ''
}

async function sendReset() {
  error.value = ''
  success.value = ''
  const isPhone = accType.value === 'phone'
  const identifier = isPhone ? normalizePhone(account.value) : (account.value || '').trim()

  if (!identifier) {
    error.value = isPhone ? '请填写手机号' : '请填写邮箱'
    return
  }
  if (isPhone && !/^\+861\d{10}$/.test(identifier)) {
    error.value = '请输入有效的 11 位手机号'
    return
  }
  if (!isPhone && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(identifier)) {
    error.value = '邮箱格式不正确'
    return
  }

  loading.value = true
  try {
    const email = isPhone ? emailForPhone(identifier) : identifier
    const { error: err } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: window.location.origin + '/',
    })
    if (err) {
      // 用户不存在时也返回友好提示（不泄露用户是否存在）
      error.value = translateError(err.message)
      return
    }
    success.value = '重置链接已发送到您的邮箱，请查收并按提示设置新密码。'
  } catch (e) {
    error.value = '网络错误，请稍后重试'
    console.error('[LoginDialog reset]', e)
  } finally {
    loading.value = false
  }
}
</script>

<style scoped>
.login-overlay {
  position: fixed; inset: 0; z-index: 100;
  background: rgba(0, 0, 0, 0.4);
  display: flex; align-items: center; justify-content: center;
}
/* 登录墙模式：品牌蓝全屏背景，不可点击遮罩关闭 */
.login-overlay--wall {
  background: #1d70b8;
  z-index: 1000;
}
.login-overlay--wall .login-dialog {
  border-width: 4px;
}
.login-dialog {
  background: #ffffff;
  border: 2px solid #1d70b8;
  width: 400px; max-width: 90vw; max-height: 90vh; overflow-y: auto;
  padding: 30px;
  position: relative;
}
.login-close {
  position: absolute; top: 8px; right: 12px;
  background: none; border: none; font-size: 24px; color: var(--text-secondary);
  cursor: pointer; padding: 4px 8px; line-height: 1;
}
.login-close:hover { color: var(--text-primary); }
.login-title {
  font-size: 24px; font-weight: 700; color: var(--text-primary);
  margin-bottom: var(--space-lg);
}

/* Tabs */
.login-tabs {
  display: flex; gap: var(--space-lg); margin-bottom: var(--space-lg);
  border-bottom: 2px solid var(--border);
}
.login-tab {
  font-size: 16px; font-weight: 700; color: var(--text-secondary);
  cursor: pointer; padding-bottom: var(--space-xs);
  border-bottom: 3px solid transparent; margin-bottom: -2px;
}
.login-tab.active {
  color: #1d70b8; border-bottom-color: #1d70b8;
}

/* 账号类型切换 */
.login-acctype {
  display: flex; gap: var(--space-sm); margin-bottom: var(--space-md);
}
.acctype-btn {
  flex: 1; padding: var(--space-xs) var(--space-sm);
  font-size: 15px; font-weight: 700; color: var(--text-secondary);
  background: #f3f3f3; border: 1px solid var(--border); cursor: pointer;
}
.acctype-btn.active {
  color: #ffffff; background: #1d70b8; border-color: #1d70b8;
}

/* Form */
.login-form {
  display: flex; flex-direction: column; gap: var(--space-md);
}
.login-label {
  font-size: 16px; font-weight: 700; color: var(--text-primary);
  margin-bottom: -8px;
}
.login-input {
  padding: var(--space-sm); border: 1px solid var(--border);
  font-size: 16px; width: 100%; box-sizing: border-box;
}
.login-input:focus { outline: 2px solid #1d70b8; outline-offset: -1px; }

.login-error {
  font-size: 14px; color: #d4351c; font-weight: 700;
}
.login-success {
  font-size: 14px; color: #00703c;
  background: #f0faf3; padding: var(--space-sm); border-left: 4px solid #00703c;
}

.login-submit {
  background: #1d70b8; color: #ffffff; border: none;
  padding: var(--space-sm) var(--space-md); font-size: 16px; font-weight: 700;
  cursor: pointer;
}
.login-submit:hover { background: #003078; }
.login-submit:disabled { opacity: 0.6; cursor: not-allowed; }

/* 忘记密码链接 */
.login-forgot {
  align-self: flex-end;
  background: none; border: none; font-size: 14px; color: #1d70b8;
  cursor: pointer; padding: 2px 4px; text-decoration: underline;
}
.login-forgot:hover { color: #003078; }

/* 返回按钮 */
.login-link-btn {
  align-self: center;
  background: none; border: 1px solid var(--border); font-size: 14px;
  color: var(--text-secondary); cursor: pointer; padding: var(--space-xs) var(--space-md);
  margin-top: var(--space-sm);
}
.login-link-btn:hover { color: #1d70b8; border-color: #1d70b8; }

.login-hint {
  font-size: 14px; color: var(--text-secondary); margin: 0 0 var(--space-md);
  background: #f3f3f3; border-left: 4px solid #1d70b8; padding: var(--space-sm) var(--space-md);
}
</style>
