export default defineUnlistedScript(() => {
  if ((window as any).__JOB_BRO_SPA_TRACKER_INSTALLED__) return
  ;(window as any).__JOB_BRO_SPA_TRACKER_INSTALLED__ = true

  const wrap = (type: 'pushState' | 'replaceState') => {
    const orig = history[type]
    return function (...args: Parameters<typeof orig>) {
      const rv = orig.apply(this, args)
      window.dispatchEvent(new Event('job-bro-url-change'))
      return rv
    }
  }

  history.pushState = wrap('pushState')
  history.replaceState = wrap('replaceState')
})
