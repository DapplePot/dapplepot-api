const isDev = process.env.NODE_ENV !== 'production'

function fmt(level: string, msg: string, meta?: unknown): string {
  const ts = new Date().toISOString()
  const base = `${ts} ${level} ${msg}`
  return meta !== undefined ? `${base} ${JSON.stringify(meta)}` : base
}

export const logger = {
  info:  (msg: string, meta?: unknown) => console.log(fmt('INFO ', msg, meta)),
  warn:  (msg: string, meta?: unknown) => console.warn(fmt('WARN ', msg, meta)),
  error: (msg: string, meta?: unknown) => console.error(fmt('ERROR', msg, meta)),
  debug: (msg: string, meta?: unknown) => { if (isDev) console.debug(fmt('DEBUG', msg, meta)) },
}
