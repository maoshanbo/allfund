/**
 * useAuth.js — Supabase Auth 单例
 *
 * 全局唯一 auth 状态，App.vue 初始化后所有组件共享同一状态。
 *
 * 权限模型（全站已取消权限墙与登录墙）：
 *  - 任何访客（含未登录）均可访问全部页面与功能，无需授权；
 *  - 登录为可选项，仅用于组合、关注等需要绑定账号的数据；
 *  - 管理员（ADMIN_EMAIL 或 user_permissions.is_admin）额外保留封禁等管理能力。
 */
import { ref, computed } from 'vue'
import { supabase, rewriteSupabaseUrl } from '../api/supabase'
import { toast } from './useToast.js'
import { upsertUserProfile, getMyPortfolios } from '../api/user-data'

// 会话最长有效期：1 周（用户要求从默认 30 天缩短）
const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
const LS_LOGIN_AT = 'dachu_auth_login_at'
const LS_LOGIN_AT_LEGACY = 'allfund_auth_login_at'

// 唯一授权管理员账户（保留封禁等管理能力）
export const ADMIN_EMAIL = '57502460@qq.com'

// ---- 全局单例状态 ----
const user = ref(null)
const loading = ref(true)
const portfolios = ref([])
const profile = ref(null)
const showLoginDialog = ref(false)

// 管理员标记（来自 user_permissions 表；管理员邮箱兜底）
const permissions = ref({ is_admin: false, enabled_features: [] })
const permissionsReady = ref(false)

// 账号是否被封禁（命中 blocked_users 表时为 true，App 显示封禁屏）
const blocked = ref(false)

// 是否已初始化（App.vue 调用 init 后为 true）
let _initDone = false
let _initFailed = false

export function useAuth() {
  const isLoggedIn = computed(() => !!user.value)

  /** 是否为管理员（硬编码管理员邮箱 或 数据库中标记为管理员） */
  const isAdmin = computed(() =>
    !!user.value && (user.value.email === ADMIN_EMAIL || permissions.value.is_admin)
  )

  /** 是否为数据中心授权账户（主管理员 或 被授予管理员权限的用户） */
  const isOwner = computed(() => user.value?.email === ADMIN_EMAIL || permissions.value.is_admin)

  /** 初始化：App.vue 挂载时调用，恢复 session 并监听状态变更 */
  async function init() {
    if (_initDone) return
    _initDone = true
    loading.value = true
    // 兜底：init 硬超时（默认 8s）。supabase.auth.getSession / loadPermissions 走的是
    // sb-proxy 链路，偶发跨境外层超时会让 await 永远挂起，loading 锁在 true → 登录墙
    // 和非墙模式的 LoginDialog 都因 v-if="!authLoading" 拒绝渲染，用户点登录「无反应」。
    // 这里用超时强制把 loading=false，并标 _initFailed，避免后续静默卡死。
    const HARD_INIT_TIMEOUT_MS = 8000
    const _initTimer = setTimeout(() => {
      if (loading.value) {
        console.warn('[auth] init 超时（' + HARD_INIT_TIMEOUT_MS + 'ms），强制进入未登录态')
        _initFailed = true
        loading.value = false
        permissionsReady.value = true
      }
    }, HARD_INIT_TIMEOUT_MS)
    try {
      const { data } = await supabase.auth.getSession()
      const u = data?.session?.user || null
      user.value = u
      if (u) {
        if (checkSessionExpiry()) {
          // 已超 1 周，内部已强制登出
        } else {
          await loadPermissions(u.email)
          await refreshUserData()
          if (await checkBlocked()) {
            // 命中封禁名单：强制登出，保持 blocked=true 以展示封禁屏
            await signOut()
            blocked.value = true
          }
        }
      } else {
        permissionsReady.value = true
      }
    } catch (e) {
      console.error('[auth] init session error:', e)
      permissionsReady.value = true
    } finally {
      clearTimeout(_initTimer)
      loading.value = false
    }
    // 监听全局状态变更
    supabase.auth.onAuthStateChange(async (event, session) => {
      const newUser = session?.user || null
      // 真正的登录（非 token 刷新）才重置 1 周会话计时
      if (event === 'SIGNED_IN') {
        localStorage.setItem(LS_LOGIN_AT, String(Date.now()))
      }
      user.value = newUser
      if (newUser) {
        await loadPermissions(newUser.email)
        await refreshUserData()
        if (await checkBlocked()) {
          await signOut()
          blocked.value = true
        }
      } else {
        localStorage.removeItem(LS_LOGIN_AT)
        portfolios.value = []
        profile.value = null
        permissions.value = { is_admin: false, enabled_features: [] }
        permissionsReady.value = true
        // 注意：blocked 不在此重置，封禁屏在登出后仍需保留，直至整页刷新
      }
    })
  }

  /** 加载当前用户的管理员标记（管理员邮箱兜底，DB 不存在时也不报错） */
  async function loadPermissions(email) {
    permissionsReady.value = false
    if (!email) {
      permissions.value = { is_admin: false, enabled_features: [] }
      permissionsReady.value = true
      return
    }
    const isAdminEmail = email === ADMIN_EMAIL
    try {
      const { data, error } = await supabase
        .from('user_permissions')
        .select('is_admin, enabled_features')
        .eq('user_email', email)
        .maybeSingle()
      if (data) {
        permissions.value = {
          is_admin: !!data.is_admin,
          enabled_features: Array.isArray(data.enabled_features) ? data.enabled_features : [],
        }
      } else {
        // 无记录：管理员兜底全开，普通用户无权限
        permissions.value = { is_admin: isAdminEmail, enabled_features: isAdminEmail ? ['all'] : [] }
      }
    } catch (e) {
      console.error('[auth] loadPermissions error:', e)
      permissions.value = { is_admin: isAdminEmail, enabled_features: isAdminEmail ? ['all'] : [] }
    } finally {
      permissionsReady.value = true
    }
  }

  /** 检查当前登录用户是否被封禁（读取 blocked_users，命中则置 blocked=true） */
  async function checkBlocked() {
    const u = user.value
    if (!u || !u.email) { blocked.value = false; return false }
    try {
      const { data, error } = await supabase
        .from('blocked_users')
        .select('user_email')
        .eq('user_email', u.email)
        .maybeSingle()
      const isBlocked = !!data && !error
      blocked.value = isBlocked
      return isBlocked
    } catch (e) {
      blocked.value = false
      return false
    }
  }

  /** 封禁某用户（仅管理员调用，依赖 RLS：`auth.email() = '57502460@qq.com'`） */
  async function blockUser(email) {
    if (!supabase) throw new Error('未连接数据库')
    const { error } = await supabase
      .from('blocked_users')
      .upsert({
        user_email: email,
        blocked_by: user.value?.email || null,
        blocked_at: new Date().toISOString(),
      }, { onConflict: 'user_email' })
    if (error) throw error
  }

  /** 解除封禁（仅管理员调用） */
  async function unblockUser(email) {
    if (!supabase) throw new Error('未连接数据库')
    const { error } = await supabase
      .from('blocked_users')
      .delete()
      .eq('user_email', email)
    if (error) throw error
  }

  /** 刷新用户数据（组合 + profile），可由外部触发 */
  async function refreshUserData() {
    const u = user.value
    if (!u) return
    try {
      await upsertUserProfile(u)
      portfolios.value = await getMyPortfolios()
    } catch (e) {
      console.error('[auth] refreshUserData error:', e)
    }
  }

  /** 显示名：优先邮箱，其次手机号；微信登录合成邮箱统一显示为「微信用户」 */
  const displayName = computed(() => {
    const u = user.value
    if (!u) return ''
    const e = u.email || ''
    if (e.endsWith('@dachu.wechat') || e.endsWith('@allfund.wechat')) return '微信用户'
    return e || u.phone || '用户'
  })
  const displayInitial = computed(() => {
    const n = displayName.value
    return n ? n[0].toUpperCase() : '?'
  })

  /** 记录本次登录起始时间（用于 1 周会话过期强制登出） */
  function markLogin() {
    const now = String(Date.now())
    localStorage.setItem(LS_LOGIN_AT, now)
    // 兼容旧 key：写入新 key 后清掉历史 key，避免重复
    try { localStorage.removeItem(LS_LOGIN_AT_LEGACY) } catch (e) {}
  }

  /** 检查会话是否已超过 1 周，超过则强制登出。返回 true 表示已过期登出 */
  function checkSessionExpiry() {
    const at = Number(localStorage.getItem(LS_LOGIN_AT) || localStorage.getItem(LS_LOGIN_AT_LEGACY) || '0')
    if (at && Date.now() - at > SESSION_MAX_AGE_MS) {
      signOut()
      toast('登录已过期（超过 7 天），请重新登录', 'info')
      return true
    }
    return false
  }

  /** 退出登录 */
  async function signOut() {
    try {
      await supabase.auth.signOut()
    } catch (e) {
      console.error('[auth] signOut error:', e)
    }
    user.value = null
    portfolios.value = []
    profile.value = null
    permissions.value = { is_admin: false, enabled_features: [] }
    permissionsReady.value = true
  }

  /** 打开登录弹窗（全局触发） */
  function showLogin() { showLoginDialog.value = true }
  function hideLogin() { showLoginDialog.value = false }

  /** 微信登录：调用 wechat-login Edge Function（type=mp|web）换取会话并写入本地 session */
  async function wechatLogin(type, code) {
    if (!supabase) throw new Error('未连接数据库')
    const url = rewriteSupabaseUrl(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/wechat-login`)
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
        Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify({ type, code }),
    })
    let data = {}
    try { data = await res.json() } catch (e) {}
    if (!res.ok) throw new Error(data.error || '微信登录失败')
    const { access_token, refresh_token } = data
    if (!access_token || !refresh_token) throw new Error('微信登录返回异常')
    const { error } = await supabase.auth.setSession({ access_token, refresh_token })
    if (error) throw error
    markLogin()
    return data
  }

  return {
    user, loading, isLoggedIn, isAdmin, isOwner, permissionsReady, blocked,
    displayName, displayInitial, portfolios, profile,
    init, signOut, refreshUserData, loadPermissions,
    checkBlocked, blockUser, unblockUser,
    showLoginDialog, showLogin, hideLogin, markLogin, wechatLogin,
  }
}
