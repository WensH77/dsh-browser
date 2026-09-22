import { createRoot } from 'react-dom/client'
import { App } from './App.tsx'
import './styles.css'
import { getUiLocale } from '../i18n.ts'

const locale = getUiLocale()
document.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'en'
document.title = locale === 'zh' ? 'AI 浏览器助手' : 'AI Browser Assistant'

const root = document.getElementById('root')
if (root === null) throw new Error('panel root missing')
createRoot(root).render(<App />)

// Signal the background that this assistant page can display approvals.
chrome.runtime.connect({ name: 'assistant' })
