import { SQL } from 'bun'
import { drizzle } from 'drizzle-orm/bun-sql'
import * as schema from './schema.ts'

const client = new SQL({
  url: 'file:./db.sqlite',
})

export const db = drizzle(client, { schema })
