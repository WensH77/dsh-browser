// What a password manager or reader does, reduced to its effect: every frame of
// every page carries hidden iframes whose documents belong to this extension.
//
// Chrome checks the tab's whole frame tree before attaching chrome.debugger, so
// one of these in any frame makes the entire tab undebuggable — which is the
// situation `browser_remove_foreign_frames` exists to work around.
const inject = (name) => {
  const frame = document.createElement('iframe')
  frame.id = `dsh-culprit-frame-${name}`
  frame.src = chrome.runtime.getURL(`frame${name}.html`)
  frame.style.cssText = 'position:fixed;left:-9999px;top:0;width:8px;height:8px;border:0'
  document.documentElement.appendChild(frame)
}

const injectAll = () => {
  for (let index = 1; index <= 2; index += 1) inject(index)
}

const start = () => {
  // Child frames only: uncomment to leave the main frame clean, which is how
  // the "does a child frame's extension frame block the attach?" case is built.
  //   if (window.top === window) return
  injectAll()
}

if (document.documentElement) {
  start()
} else {
  // document_start can precede the root element; wait for the first one.
  const observer = new MutationObserver(() => {
    if (!document.documentElement) return
    observer.disconnect()
    start()
  })
  observer.observe(document, { childList: true })
}
