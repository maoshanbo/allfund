import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    // 解决腾讯行情 / 蛋卷的 CORS 问题（开发环境代理）
    proxy: {
      '/api/qt': {
        target: 'https://qt.gtimg.cn',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/qt/, ''),
      },
      // 蛋卷基金估值 API 代理（开发环境直连，避免 CORS）
      '/api/danjuan': {
        target: 'https://danjuanfunds.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/danjuan/, ''),
      },
    }
  },
  build: {
    outDir: 'dist',
    // EdgeOne Pages 会给 JS 资源加内容指纹并改写引用，但对 JS 内动态引用的
    // 页面级 CSS chunk 不改写，导致 /assets/<Page>-XXXX.css 全部 404（回退
    // index.html）→ 全站样式丢失。关闭 CSS 代码分割，把所有样式合并进单个
    // 全局 index-*.css，规避该问题。
    cssCodeSplit: false,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/vue/') || id.includes('node_modules/@vue/') || id.includes('node_modules/vue-router/')) return 'vendor'
          if (id.includes('node_modules/@supabase/')) return 'supabase'
          if (id.includes('node_modules/echarts/')) return 'echarts'
        }
      }
    }
  }
})
