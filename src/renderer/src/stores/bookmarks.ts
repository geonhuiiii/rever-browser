import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export interface Bookmark {
  id: string
  url: string
  title: string
  addedAt: number
}

interface BookmarksState {
  bookmarks: Bookmark[]
  add: (b: { url: string; title: string }) => void
  remove: (id: string) => void
  removeByUrl: (url: string) => void
}

function newId(): string {
  return `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

export const useBookmarksStore = create<BookmarksState>()(
  persist(
    (set) => ({
      bookmarks: [],
      add: ({ url, title }) =>
        set((s) => {
          if (s.bookmarks.some((b) => b.url === url)) return s
          return {
            bookmarks: [
              ...s.bookmarks,
              { id: newId(), url, title: title || url, addedAt: Date.now() }
            ]
          }
        }),
      remove: (id) => set((s) => ({ bookmarks: s.bookmarks.filter((b) => b.id !== id) })),
      removeByUrl: (url) => set((s) => ({ bookmarks: s.bookmarks.filter((b) => b.url !== url) }))
    }),
    {
      name: 'rev:bookmarks',
      partialize: (s) => ({ bookmarks: s.bookmarks })
    }
  )
)
