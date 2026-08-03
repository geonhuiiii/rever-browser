import { useTabsStore } from '@/stores/tabs'

export function TabBar() {
  const tabs = useTabsStore((s) => s.tabs)
  const activeId = useTabsStore((s) => s.activeId)
  const selectTab = useTabsStore((s) => s.selectTab)
  const closeTab = useTabsStore((s) => s.closeTab)
  const addTab = useTabsStore((s) => s.addTab)

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-end',
        gap: 2,
        flex: 1,
        minWidth: 0,
        height: '100%',
        overflowX: 'auto'
      }}
    >
      {tabs.map((t) => {
        const isActive = t.id === activeId
        const isolated = !!t.partition
        return (
          <div
            key={t.id}
            onClick={() => selectTab(t.id)}
            onAuxClick={(e) => {
              if (e.button === 1) closeTab(t.id) // middle-click close
            }}
            style={
              {
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '6px 8px 6px 10px',
                minWidth: 120,
                maxWidth: 220,
                cursor: 'pointer',
                borderRadius: '6px 6px 0 0',
                background: isolated
                  ? 'var(--proxy-tab-bg)'
                  : isActive
                    ? 'var(--bg)'
                    : 'transparent',
                borderTop: `1px solid ${isActive ? (isolated ? 'var(--proxy-tab-border)' : 'var(--border-2)') : 'transparent'}`,
                borderLeft: `1px solid ${isActive ? (isolated ? 'var(--proxy-tab-border)' : 'var(--border-2)') : 'transparent'}`,
                borderRight: `1px solid ${isActive ? (isolated ? 'var(--proxy-tab-border)' : 'var(--border-2)') : 'transparent'}`,
                fontSize: 12,
                color: isolated
                  ? 'var(--proxy-tab-text)'
                  : isActive
                    ? 'var(--text)'
                    : 'var(--text-dim)',
                opacity: isolated && !isActive ? 0.75 : 1,
                userSelect: 'none',
                WebkitAppRegion: 'no-drag'
              } as React.CSSProperties
            }
          >
            {isolated && (
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: 3,
                  background: 'var(--proxy-tab-dot)',
                  flexShrink: 0
                }}
                title={
                  t.proxy?.enabled
                    ? `Isolated proxy tab — ${t.proxy.host}:${t.proxy.port}, own cookies`
                    : 'Isolated tab — own cookies (proxy disabled)'
                }
              />
            )}
            <span
              style={{
                flex: 1,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap'
              }}
              title={t.url}
            >
              {t.title || t.url}
            </span>
            {tabs.length > 1 && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  closeTab(t.id)
                }}
                style={{
                  width: 16,
                  height: 16,
                  padding: 0,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  background: 'transparent',
                  border: 'none',
                  color: 'var(--text-dim)',
                  cursor: 'pointer',
                  fontSize: 14,
                  lineHeight: 1
                }}
                title="Close tab"
              >
                ×
              </button>
            )}
          </div>
        )
      })}

      <button
        type="button"
        onClick={() => addTab('https://www.google.com')}
        style={
          {
            padding: '4px 10px',
            marginLeft: 4,
            marginBottom: 2,
            background: 'transparent',
            border: '1px solid var(--border-2)',
            borderRadius: 4,
            color: 'var(--text-2)',
            cursor: 'pointer',
            fontSize: 14,
            lineHeight: 1,
            WebkitAppRegion: 'no-drag'
          } as React.CSSProperties
        }
        title="New tab"
      >
        +
      </button>
    </div>
  )
}
