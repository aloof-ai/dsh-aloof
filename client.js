/**
 * 浏览器半部：dsh 界面右下角那颗常驻的 Aloof 按钮。
 *
 * 折叠态就是一颗带 logo 的圆钮 + 一个红绿灯，点开是一张卡：连的哪台、认出你是谁、用的哪张票，
 * 连不上时把报错和排查顺序一起摆出来。它和 `/aloof` 命令读的是**同一个** `status()`
 * （经 `GET /dsh-aloof/status`），所以两处口径不会分叉。
 *
 * ── 为什么这个文件是手写的产物、而不是编译出来的 ──────────────────────────
 *
 * dsh 的 client 产物形状是固定的：一个 CJS 闭包工厂，包在
 * `window.__ModuleLoader__.load({ id, factory })` 里，`require` 由宿主的模块表回答
 * （react / cordis / slots 这些「平台模块」都从那儿来，不打进包）。
 *
 * 官方包用 tsdown 的 `clientBundle` preset 生成这个形状。我们**不引那条流水线**，因为这颗
 * 按钮除了 react 什么都不需要——引进来换到的是 tsc + tsdown + 一串 `@deepseek-ai/dsh-client-*`
 * 开发依赖，而那些包在 npm 上的版本（`0.0.1-rc.1`）比宿主实际跑的（`0.1.0-rc.5`）旧，
 * 等于**照着旧类型写、跑在新宿主上**。代价是这里不能用 JSX 和 CSS Modules：用
 * `React.createElement`（下面别名 `h`）和一段注入的 `<style>` 顶上，对一个悬浮按钮来说很够。
 *
 * 这和 `index.js` 里「整份文件没有一句 import」是同一个取舍，理由也一样：这个插件是薄壳，
 * 少一层构建就少一处会在别人机器上坏掉的地方。
 *
 * **动这个文件时记住**：`banner`/`footer`/`intro` 三段是和宿主 loader 的约定，别改；
 * 要改就照 `deepseek-harness/packages/client/tsdown.client.ts` 里 `clientConfig()` 的输出对。
 */
window.__ModuleLoader__.load({
  id: 'dsh-aloof',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const h = React.createElement

    /** 状态接口的地址。同源，所以相对路径就够——票留在 Node 那边，页面只拿结论。 */
    const STATUS_URL = '/dsh-aloof/status'

    /** 没人操作时的复查间隔。票是会在别处失效的（被吊销、改密连带、过期），红绿灯得自己变。 */
    const POLL_MS = 30_000

    /**
     * 公司 logo 的两条路径，坐标系 `viewBox 0 0 100 100`。**别手改。**
     * 和 Aloof 网页、favicon 用的是同一份成品（`aloof/web/src/logo-paths.ts`）。
     * 左片在原标里更暗（画的时候给 0.55 不透明度），右片实色——这个明暗差是标的层次，
     * 所以两条路径不能合成一条。
     */
    const BLADE_LEFT = 'M18.65 4.22C18.92 4.22 19.2 4.22 19.48 4.2C19.76 4.2 20.04 4.2 20.34 4.2C20.64 4.2 20.94 4.2 21.26 4.2C21.88 4.2 22.5 4.2 23.14 4.2C24.11 4.2 25.07 4.2 26.03 4.2C26.65 4.2 27.27 4.2 27.87 4.2C28.17 4.2 28.46 4.2 28.76 4.2C29.02 4.2 29.3 4.2 29.58 4.2C29.7 4.2 29.7 4.2 30.28 4.2C31.58 4.32 32.2 4.67 33.12 5.61C33.97 6.85 34.53 8.15 35.15 9.52C35.61 10.4 36.11 11.04 36.81 11.78C37.33 12.52 37.79 13.24 38.18 14.09C38.98 15.59 40.2 16.67 41.4 17.87C41.64 18.11 41.88 18.37 42.14 18.63C44.53 21.04 46.99 22.54 50.34 23.14C50.88 23.42 51.44 23.69 52 23.97C52.38 24.05 52.75 24.13 53.15 24.21C54.35 24.47 54.35 24.47 55.37 24.99C56.65 25.53 57.74 25.65 59.14 25.73C59.86 25.81 59.86 25.81 60.52 26.15C59.08 27.57 58 27.89 56.01 28.31C55.45 28.58 54.89 28.86 54.35 29.16C52.77 29.54 51 29.36 49.38 29.36C48.98 29.36 48.58 29.36 48.18 29.38C47.8 29.38 47.41 29.38 47.01 29.38C46.83 29.38 46.83 29.38 45.95 29.38C44.43 29.28 43.29 28.76 41.96 28.03C40.96 27.49 39.96 26.95 38.92 26.45C38.72 26.33 38.5 26.23 38.28 26.11C37.67 25.83 37.07 25.57 36.45 25.29C35.21 24.59 34.43 23.77 33.45 22.74C32.8 22.14 32.3 21.86 31.5 21.5C29.96 20.76 28.84 19.66 27.61 18.45C27.43 18.27 27.23 18.09 27.03 17.89C26.09 16.93 25.39 16.07 24.83 14.83C23.69 12.5 21.58 10.82 19.76 9.05C19.18 8.49 18.59 7.93 18.03 7.37C17.67 7.01 17.31 6.67 16.95 6.33C16.55 5.93 16.15 5.53 15.77 5.11C15.81 4.93 15.87 4.77 15.93 4.61C16.85 4.3 17.69 4.22 18.65 4.22ZM6.39 16.51C7.07 16.79 7.07 16.79 7.91 17.29C8.27 17.37 8.65 17.45 9.03 17.51C10.16 17.77 10.92 18.11 11.92 18.63C12.3 18.71 12.68 18.79 13.08 18.88C14.19 19.12 14.93 19.48 15.93 19.96C16.27 20.04 16.63 20.1 16.99 20.16C19.58 20.78 21.9 22.18 24.25 23.42C24.83 23.75 25.43 24.03 26.03 24.31C27.13 24.91 27.99 25.67 28.96 26.47C29.28 26.65 29.62 26.81 29.96 26.97C30.96 27.47 30.96 27.47 31.94 28.29C32.84 29.06 33.65 29.48 34.69 29.96C35.65 30.52 36.33 31.34 37.07 32.16C37.75 32.78 38.3 33.08 39.12 33.49C40.92 34.39 42.22 35.69 43.63 37.13C43.89 37.37 44.13 37.61 44.39 37.85C46.81 40.28 48.52 42.83 48.52 46.31C48.52 46.71 48.52 47.13 48.52 47.57C48.52 48.04 48.52 48.5 48.52 48.96C48.52 49.44 48.52 49.94 48.52 50.42C48.52 51.74 48.52 53.07 48.52 54.41C48.52 55.51 48.52 56.61 48.52 57.72C48.54 60.32 48.54 62.93 48.54 65.53C48.54 68.24 48.54 70.92 48.54 73.61C48.54 75.91 48.54 78.24 48.54 80.54C48.54 81.93 48.54 83.31 48.54 84.67C48.54 85.97 48.54 87.28 48.54 88.58C48.54 89.04 48.54 89.52 48.54 90C48.54 90.64 48.54 91.31 48.54 91.95C48.54 92.31 48.54 92.69 48.54 93.05C48.5 93.95 48.5 93.95 48.16 94.95C47.9 95.01 47.62 95.07 47.33 95.11C46.15 93.95 45.57 92.57 44.83 91.11C44.71 90.91 44.59 90.68 44.47 90.46C43.73 89.1 43.45 87.8 43.15 86.28C42.7 85.39 42.7 85.39 42.32 84.77C42.14 84.09 42.14 84.09 42.12 82.85C42.04 81.51 41.64 80.58 40.98 79.42C40.8 78.7 40.8 78.1 40.8 77.36C40.8 77.08 40.8 76.78 40.78 76.48C40.78 76.31 40.78 76.31 40.78 75.51C40.78 75.17 40.78 74.83 40.78 74.49C40.78 73.75 40.78 73.03 40.78 72.29C40.78 71.12 40.78 69.96 40.78 68.82C40.76 65.51 40.76 62.23 40.76 58.92C40.76 56.91 40.76 54.89 40.74 52.87C40.74 52.1 40.74 51.34 40.74 50.56C40.74 49.5 40.74 48.42 40.74 47.33C40.74 47.03 40.74 46.71 40.74 46.37C40.74 46.09 40.74 45.79 40.74 45.49C40.74 45.23 40.74 44.99 40.74 44.73C40.52 43.03 39.42 41.88 38.14 40.84C37.51 40.48 36.89 40.16 36.25 39.84C35.63 39.5 35.63 39.5 34.65 38.68C33.49 37.71 32.32 37.13 30.96 36.49C30.52 36.27 30.08 36.05 29.62 35.83C29.4 35.73 29.18 35.61 28.96 35.49C28.29 35.17 27.61 34.83 26.95 34.49C26.73 34.39 26.51 34.27 26.29 34.17C25.83 33.93 25.35 33.69 24.89 33.47C24.65 33.35 24.43 33.23 24.17 33.1C23.97 32.98 23.75 32.88 23.52 32.76C22.74 32.4 22 32.16 21.14 32.02C20.28 31.82 20.28 31.82 19.48 31.42C18.59 30.98 18.59 30.98 17.43 30.74C16.35 30.5 15.57 30.18 14.59 29.66C13.48 29.38 12.32 29.42 11.18 29.4C9.9 29.3 8.99 28.98 7.91 28.31C6.83 28.03 5.71 28.09 4.59 28.05C3.74 27.97 3.74 27.97 2.56 27.47C2 26.35 2 25.75 2 24.51C2 24.13 2 23.75 2 23.34C2 22.94 2 22.54 2 22.14C2 21.74 2 21.34 2 20.92C2 20.72 2 20.72 2 19.76C2 19.4 2 19.06 2 18.69C2.06 17.79 2.06 17.79 2.56 16.79C3.96 16.19 4.93 16.11 6.39 16.51Z'
    const BLADE_RIGHT = 'M70.58 4.24C70.72 4.24 70.72 4.24 71.44 4.24C71.75 4.24 72.07 4.24 72.37 4.24C72.69 4.24 73.01 4.24 73.33 4.24C73.99 4.22 74.67 4.22 75.33 4.22C76.35 4.22 77.38 4.22 78.4 4.22C79.04 4.22 79.68 4.22 80.34 4.22C80.48 4.22 80.48 4.22 81.27 4.22C81.41 4.22 81.41 4.22 82.13 4.22C82.39 4.22 82.63 4.22 82.89 4.22C83.57 4.26 83.57 4.26 84.73 4.61C84.79 4.87 84.85 5.15 84.91 5.43C84.07 6.27 84.07 6.27 83.05 6.81C81.35 7.75 80.1 9.07 78.76 10.44C78.28 10.92 77.78 11.4 77.3 11.88C75.73 13.44 74.45 14.85 73.51 16.85C72.39 19.12 70.12 20.72 67.88 21.76C66.88 22.32 66.15 23.1 65.39 23.95C63.55 25.79 61.16 25.35 58.72 25.35C58.52 25.35 58.52 25.35 57.52 25.37C57.13 25.37 56.75 25.37 56.35 25.37C55.99 25.37 55.65 25.37 55.27 25.37C54.39 25.31 53.79 25.23 53.01 24.81C52.73 24.47 52.47 24.15 52.16 23.81C52.36 22.6 52.55 22.48 53.51 21.8C53.81 21.66 54.13 21.52 54.45 21.36C56.11 20.48 57.32 19.16 58.66 17.81C59.14 17.33 59.62 16.85 60.1 16.37C61.66 14.81 63.01 13.36 63.93 11.34C64.31 10.56 64.91 10.06 65.53 9.44C66.03 8.57 66.43 7.67 66.88 6.77C67.78 5.01 67.78 5.01 68.54 4.43C69.26 4.24 69.84 4.24 70.58 4.24ZM94.65 16.25C94.77 16.25 94.77 16.25 95.47 16.23C96.26 16.29 96.26 16.29 97.44 16.79C97.96 17.85 98 18.33 98 19.5C98 19.82 98 20.16 98 20.5C98 20.66 98 20.66 98 21.54C98 21.88 98 22.22 98 22.58C98 22.92 98 23.24 98 23.58C98 23.89 98 24.19 98 24.51C97.9 25.79 97.5 26.41 96.6 27.31C95.84 27.77 95.25 27.97 94.37 28.13C93.37 28.33 92.65 28.68 91.75 29.16C90.62 29.44 89.48 29.38 88.32 29.4C87.2 29.5 86.38 29.84 85.35 30.34C84.57 30.66 84.57 30.66 83.67 30.8C82.73 30.98 82.73 30.98 81.95 31.38C80.98 31.86 80.06 32.08 79 32.32C78.4 32.48 78.4 32.48 77.72 32.82C77.06 33.16 77.06 33.16 75.81 33.45C74.31 33.81 73.07 34.45 71.71 35.17C71.44 35.29 71.16 35.43 70.9 35.57C69.34 36.35 68.16 37.15 66.88 38.34C65.81 38.94 64.69 39.46 63.57 39.96C61.64 40.84 60.18 42.02 59.36 44.01C59.28 44.71 59.28 44.71 59.28 45.49C59.26 45.77 59.26 46.07 59.26 46.37C59.26 46.69 59.26 47.01 59.28 47.33C59.26 47.68 59.26 48.02 59.26 48.36C59.26 49.08 59.26 49.82 59.26 50.54C59.26 51.7 59.26 52.87 59.26 54.01C59.26 56.05 59.26 58.1 59.26 60.14C59.26 63.39 59.26 66.65 59.26 69.92C59.24 71.06 59.24 72.21 59.26 73.35C59.26 74.03 59.24 74.73 59.24 75.43C59.24 75.75 59.26 76.07 59.26 76.39C59.26 76.7 59.24 76.98 59.24 77.28C59.24 77.42 59.24 77.42 59.24 78.06C59.16 79.06 58.82 79.84 58.32 80.72C57.92 81.65 57.94 82.43 57.92 83.43C57.9 85.37 57.48 86.58 56.57 88.28C56.03 89.28 55.49 90.3 54.99 91.33C53.19 94.93 53.19 94.93 52.34 95.8C52.16 95.74 52 95.68 51.84 95.62C51.26 94.47 51.48 92.81 51.48 91.55C51.48 91.15 51.48 90.72 51.48 90.3C51.48 89.84 51.48 89.38 51.48 88.92C51.48 88.44 51.48 87.96 51.48 87.48C51.46 86.16 51.46 84.85 51.46 83.55C51.46 82.73 51.46 81.91 51.46 81.08C51.46 78.52 51.46 75.95 51.46 73.39C51.46 70.44 51.46 67.48 51.46 64.53C51.44 62.25 51.44 59.94 51.44 57.66C51.44 56.29 51.44 54.93 51.44 53.57C51.44 52.28 51.44 51 51.44 49.72C51.44 49.24 51.44 48.78 51.44 48.3C51.44 47.66 51.44 47.01 51.44 46.37C51.44 46.01 51.44 45.65 51.44 45.27C51.5 44.41 51.64 43.81 52 43.01C52.04 42.91 52.04 42.91 52.26 42.38C53.29 40.22 54.83 38.64 56.53 36.97C57.01 36.49 57.5 36.01 57.96 35.53C59.52 33.99 60.94 32.7 62.95 31.78C63.73 31.4 64.23 30.88 64.79 30.24C65.83 29.12 66.86 28.48 68.24 27.81C68.88 27.47 68.88 27.47 69.72 26.71C70.78 25.77 71.93 25.25 73.21 24.65C73.67 24.43 74.11 24.21 74.55 23.97C77.22 22.64 77.22 22.64 77.9 22.3C78.34 22.08 78.78 21.86 79.2 21.64C79.88 21.3 80.56 20.96 81.23 20.64C81.37 20.56 81.37 20.56 82.01 20.24C83.69 19.42 85.25 18.88 87.08 18.45C87.3 18.35 87.52 18.23 87.74 18.13C88.62 17.69 89.5 17.51 90.44 17.29C91.17 17.11 91.77 16.81 92.43 16.45C93.19 16.27 93.85 16.25 94.65 16.25Z'

    /**
     * 那些做不到内联 `style` 的东西：keyframes、`:hover`、`:active`。
     *
     * `data-plugin` 是宿主 loader 卸载时清理样式的钩子（官方 CSS Modules 产物打的也是这个
     * 标记），所以插件被卸掉之后不会留下孤儿样式。存在性检查让重复执行是幂等的。
     */
    const CSS = `
.aloof-fab{position:absolute;right:18px;bottom:18px;display:flex;flex-direction:column;align-items:flex-end;gap:10px;font:13px/1.5 var(--dsw-font-family,system-ui,-apple-system,"Segoe UI",sans-serif)}
.aloof-fab-btn{position:relative;width:46px;height:46px;border:0;border-radius:50%;padding:0;cursor:pointer;background:var(--dsw-alias-bg-inverse,#1d1d1f);box-shadow:0 6px 20px rgba(0,0,0,.22);transition:transform .18s ease,box-shadow .18s ease;display:grid;place-items:center}
.aloof-fab-btn:hover{transform:translateY(-2px) scale(1.05);box-shadow:0 10px 26px rgba(0,0,0,.28)}
.aloof-fab-btn:active{transform:translateY(0) scale(.97)}
.aloof-fab-dot{position:absolute;right:-1px;bottom:-1px;width:13px;height:13px;border-radius:50%;border:2.5px solid var(--dsw-alias-bg-primary,#fff)}
.aloof-fab-dot[data-live="yes"]{background:#22c55e;animation:aloof-fab-breathe 2.4s ease-in-out infinite}
.aloof-fab-dot[data-live="no"]{background:#ef4444}
.aloof-fab-dot[data-live="wait"]{background:#9ca3af;animation:aloof-fab-breathe 1.1s ease-in-out infinite}
@keyframes aloof-fab-breathe{0%,100%{opacity:1}50%{opacity:.45}}
.aloof-fab-card{width:290px;padding:14px 15px;border-radius:14px;background:var(--dsw-alias-bg-elevated,var(--dsw-alias-bg-primary,#fff));color:var(--dsw-alias-label-primary,#1d1d1f);border:1px solid var(--dsw-alias-border-primary,rgba(0,0,0,.09));box-shadow:0 12px 34px rgba(0,0,0,.16);animation:aloof-fab-rise .16s ease-out}
@keyframes aloof-fab-rise{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
.aloof-fab-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:10px;font-weight:600}
.aloof-fab-row{display:flex;gap:8px;padding:3px 0}
.aloof-fab-key{flex:0 0 42px;color:var(--dsw-alias-label-secondary,#6b7280)}
.aloof-fab-val{flex:1;min-width:0;word-break:break-all}
.aloof-fab-why{margin-top:10px;padding-top:10px;border-top:1px solid var(--dsw-alias-border-primary,rgba(0,0,0,.09));color:var(--dsw-alias-label-secondary,#6b7280)}
.aloof-fab-recheck{border:0;background:none;padding:0;cursor:pointer;color:var(--dsw-alias-label-secondary,#6b7280);font:inherit;text-decoration:underline}
.aloof-fab-recheck:hover{color:var(--dsw-alias-label-primary,#1d1d1f)}
`

    if (typeof document !== 'undefined'
      && document.querySelector('style[data-plugin-css="dsh-aloof/fab"]') === null) {
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-aloof'
      tag.dataset.pluginCss = 'dsh-aloof/fab'
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    /** logo：白色描在黑底上，明暗两片保住原标的层次。 */
    function Mark(props) {
      return h('svg', { width: props.size, height: props.size, viewBox: '0 0 100 100', 'aria-hidden': true }, [
        h('path', { key: 'l', d: BLADE_LEFT, fill: '#fff', opacity: 0.55 }),
        h('path', { key: 'r', d: BLADE_RIGHT, fill: '#fff' }),
      ])
    }

    function Row(props) {
      return h('div', { className: 'aloof-fab-row' }, [
        h('span', { key: 'k', className: 'aloof-fab-key' }, props.k),
        h('span', { key: 'v', className: 'aloof-fab-val' }, props.children),
      ])
    }

    /**
     * 拉一次状态。**自己不抛**：连不上是一种状态而不是错误，Host 侧的 `status()` 已经是
     * 这个约定，这里只补上「连 Host 都没答」这一种（dsh 自己在重启之类）。
     */
    async function fetchStatus(signal) {
      try {
        const res = await fetch(STATUS_URL, { signal, headers: { accept: 'application/json' } })
        if (!res.ok) {
          return { connected: false, base: null, prefix: null, user: null,
            error: `插件的状态接口回了 ${res.status}` }
        }
        return await res.json()
      } catch (error) {
        if (signal !== undefined && signal.aborted) return null
        return { connected: false, base: null, prefix: null, user: null,
          error: `问不到本机插件：${error instanceof Error ? error.message : String(error)}` }
      }
    }

    /** 右下角那颗按钮 + 点开的那张卡。 */
    function AloofFab() {
      const [state, setState] = React.useState(null)
      const [open, setOpen] = React.useState(false)
      const [checking, setChecking] = React.useState(false)

      const load = React.useCallback((signal) => {
        setChecking(true)
        return fetchStatus(signal).then((next) => {
          // `null` = 这次请求被取消了（组件卸了 / 又发了一次），别拿它覆盖已有状态。
          if (next !== null) setState(next)
          setChecking(false)
        })
      }, [])

      React.useEffect(() => {
        const abort = new AbortController()
        void load(abort.signal)
        // 定时复查：票会在别处失效（被吊销、改密连带、到期），红绿灯得自己跟上，
        // 不能等人点开才发现。
        const timer = setInterval(() => void load(abort.signal), POLL_MS)
        return () => {
          abort.abort()
          clearInterval(timer)
        }
      }, [load])

      const live = state === null ? 'wait' : (state.connected ? 'yes' : 'no')
      const title = state === null
        ? 'Aloof：正在看'
        : (state.connected ? 'Aloof：已连上' : 'Aloof：连不上')

      return h('div', { className: 'aloof-fab' }, [
        open && state !== null ? h('div', { key: 'card', className: 'aloof-fab-card' }, [
          h('div', { key: 'head', className: 'aloof-fab-head' }, [
            h('span', { key: 't' }, title),
            h('button', {
              key: 'r',
              className: 'aloof-fab-recheck',
              type: 'button',
              onClick: () => void load(),
            }, checking ? '看着…' : '重新看'),
          ]),

          // 连地址都没解析出来（没配票 / 票不带地址）：这时候「打算连哪」都说不出，
          // 摆一堆空行没意义，直接把那句怎么配透出去。
          state.base === null
            ? h('div', { key: 'no-base' }, state.error)
            : [
              h(Row, { key: 'base', k: '地址' }, state.base),
              h(Row, { key: 'tok', k: '用票' }, `${state.prefix}…`),
              state.user !== null && state.user !== undefined
                ? h(Row, { key: 'who', k: '身份' },
                  `${state.user.name}（${state.user.username}）${state.user.isAdmin ? ' · 有管理权限' : ''}`)
                : null,
              state.connected ? null : h('div', { key: 'why', className: 'aloof-fab-why' }, [
                h('div', { key: 'e' }, state.error),
                h('div', { key: 'h', style: { marginTop: 6 } },
                  '先看上面那个地址对不对——换过环境的话很可能是旧票，再查网络。'),
              ]),
            ],
        ]) : null,

        h('button', {
          key: 'btn',
          className: 'aloof-fab-btn',
          type: 'button',
          // 折叠着的时候，这个 title 就是「不点开也知道通没通」那条路
          title,
          'aria-label': title,
          'aria-expanded': open,
          onClick: () => setOpen((v) => !v),
        }, [
          h(Mark, { key: 'm', size: 21 }),
          h('span', { key: 'd', className: 'aloof-fab-dot', 'data-live': live }),
        ]),
      ])
    }

    exports.name = 'dsh-aloof-fab'

    /** `slots` 是唯一要的服务：这半部只往界面上挂东西，票和网络都在 Node 那边。 */
    exports.inject = ['slots']

    /**
     * @param {any} ctx 宿主给的（受限）client ctx
     */
    exports.apply = function apply(ctx) {
      // `shell.overlay` 是根作用域的 list 槽，铺满整个 shell、默认穿透点击（层自己是
      // `pointer-events:none`，直接子元素才是 `auto`）。所以这颗按钮浮在所有页面之上、
      // 又不挡住下面任何东西——正是常驻状态灯要的位置。
      //
      // 必须用 `inject('shell.overlay', ...)` 包一层：槽只在声明它的那位（ui-layout）
      // 活着的时候存在，直接 register 会在装配里没有 shell 的情况下炸。
      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'aloof-status',
        label: 'Aloof',
      }, AloofFab))
    }

    return module.exports
  },
})
