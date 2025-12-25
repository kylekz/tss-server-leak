import { createFileRoute } from '@tanstack/react-router'
import {
  createMiddleware,
  createServerFn,
  useServerFn,
} from '@tanstack/react-start'
import { sql } from 'drizzle-orm'
import { useMutation } from '@tanstack/react-query'
import { db } from '@/db'

export const Route = createFileRoute('/')({ component: App })

function App() {
  return (
    <div className="p-12 bg-white">
      <SongsButton />
    </div>
  )
}

function SongsButton() {
  const mutationFn = useServerFn($getRandomSong)
  const mutation = useMutation({
    mutationFn,
    onSuccess: (data) => {
      alert(`Random song: ${data.name} by ${data.artist}`)
    },
  })

  function handleClick() {
    mutation.mutate({})
  }

  return (
    <button
      className="px-2 py-1 bg-blue-500 rounded-md text-white"
      onClick={handleClick}
    >
      Get Random Song
    </button>
  )
}

export const authMiddleware = createMiddleware({ type: 'function' }).server(
  async ({ next }) => {
    return next({
      context: {
        user: 1,
      },
    })
  },
)

const songs = [
  { id: 1, name: 'Teenage Dirtbag', artist: 'Wheatus' },
  { id: 2, name: 'Smells Like Teen Spirit', artist: 'Nirvana' },
  { id: 3, name: 'The Middle', artist: 'Jimmy Eat World' },
  { id: 4, name: 'My Own Worst Enemy', artist: 'Lit' },
  { id: 5, name: 'Fat Lip', artist: 'Sum 41' },
  { id: 6, name: 'All the Small Things', artist: 'blink-182' },
  { id: 7, name: 'Beverly Hills', artist: 'Weezer' },
]

export const $getRandomSong = createServerFn({
  method: 'POST',
})
  .middleware([authMiddleware])
  .handler(async () => {
    await db.execute(sql`SELECT 1`)

    return songs[Math.floor(Math.random() * songs.length)]
  })
