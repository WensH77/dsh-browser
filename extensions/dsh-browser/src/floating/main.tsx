import { createRoot } from 'react-dom/client'
import { App } from '../panel/App.tsx'
import '../panel/styles.css'
import { getUiLocale } from '../i18n.ts'

const locale = getUiLocale()
document.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'en'
document.title = locale === 'zh' ? 'dsh 浏览器助手' : 'dsh Browser Assistant'

const root = document.getElementById('root')
if (root === null) throw new Error('floating root missing')
createRoot(root).render(<App />)

// Signal the background that this assistant page can display approvals.
chrome.runtime.connect({ name: 'assistant' })
