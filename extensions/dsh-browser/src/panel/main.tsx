import { createRoot } from 'react-dom/client'
import { App, appName } from './App.tsx'
import './styles.css'
import { localeFromUiState } from '../i18n.ts'
import { sendUiRequest, type UiState } from '../shared/messages.ts'

// The language is a user setting, so the worker is the only document that knows
// it. The document's own name and language are set from the same snapshot the
// panel renders from; a worker that does not answer leaves both in English.
void sendUiRequest({ type: 'ui.state' }).then((value) => {
  const locale = localeFromUiState(value as UiState | null)
  document.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'en'
  document.title = appName(locale)
}).catch(() => {})

const root = document.getElementById('root')
if (root === null) throw new Error('panel root missing')
createRoot(root).render(<App />)

// Signal the background that this assistant page can display approvals.
chrome.runtime.connect({ name: 'assistant' })
