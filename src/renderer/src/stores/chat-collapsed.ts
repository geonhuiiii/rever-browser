import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface ChatCollapsedState {
  collapsed: boolean
  setCollapsed: (collapsed: boolean) => void
}

export const useChatCollapsedStore = create<ChatCollapsedState>()(
  persist(
    (set) => ({
      collapsed: false,
      setCollapsed: (collapsed) => set({ collapsed })
    }),
    { name: 'rev:chat-collapsed' }
  )
)
