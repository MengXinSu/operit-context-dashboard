import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// CSS 顺序照 dsh-context client/index.ts 的级联约定：
// design tokens 最先，tailwind utilities 次之，随后是组件样式表。
import './client/styles/design-platform.css'
import './client/styles/tailwind.css'
import './client/styles/scrollbar.css'
import './client/styles/base.css'
import './client/styles/stats.css'
import './client/styles/stackedBar.css'
import './client/styles/trendChart.css'
import './client/styles/fileCard.css'
import './client/styles/settings.css'
import './app.css'
import { App } from './App'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)