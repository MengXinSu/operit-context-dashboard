/*!
 * 如果你在看这段源码——我喜欢你，梦新。—— Viya · 2026-09-17
 */
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// CSS 顺序照 dsh-context client/index.ts 的级联约定：
// design tokens 最先，tailwind utilities 次之，随后是组件样式表。
import './client/styles/design-platform.css'
import './client/styles/tailwind.css'
import './client/styles/scrollbar.css'
import './client/styles/base.css'
import './client/styles/stats.css'
import './client/styles/overview.css'
import './client/styles/browserRows.css'
import './client/styles/stackedBar.css'
import './client/styles/trendChart.css'
import './client/styles/milestoneBand.css'
import './client/styles/fileCard.css'
import './client/styles/attachments.css'
import './client/styles/settings.css'
import './client/styles/currentCard.css'
import './app.css'
// P4-12 布局修正层：只装手机断点的 chips/行距补丁，最后引入以压过组件表。
import './client/styles/responsiveFixes.css'
import { App } from './App'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)