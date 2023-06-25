import { createWriteStream } from 'fs'
import { unlink } from 'fs/promises'
import http, { RequestOptions } from 'http'
import https from 'https'

const Protocols = { http, https }
function getProtocolAdapter(url: string | URL) {
  if (typeof url === 'string') url = new URL(url)
  return Protocols[url.protocol.slice(0, -1) as 'http' | 'https']
}

export async function request<T extends any>(url: string): Promise<T> {
  let data, type
  try {
    const res = await fetch(url)
    type = res.headers.get('Content-Type')
    if (type === 'application/json') {
      data = await res.json()
      if ((!data || !data.status) && !res.ok)
        data = { status: res.status, message: res.statusText }
    } else {
      if (!res.ok) throw new Error(`Error ${res.status}: ${res.statusText}`)
      data = await res.text()
    }
  } catch (err: any) {
    if (type === 'application/json')
      data = { status: -1, message: err.message || 'Fetch Request Failed' }
    else throw err
  }
  if (data.status) throw new StatusError(data.status, data.message)
  return data
}

export function download(
  uri: string,
  path: string,
  encoding?: BufferEncoding,
  progressCallback: (current: number, total: number) => void = () => {}
) {
  const url = new URL(uri)
  const options: RequestOptions = {
    hostname: url.hostname,
    port: url.port,
    path: url.pathname + url.search,
    method: 'GET',
    headers: {
      'Accept': '*/*',
      'Referer': 'no-referer',
      'User-Agent': 'node-fetch',
      'Accept-Encoding': 'gzip, deflate, br'
    }
  }

  return new Promise<void>((resolve, reject) => {
    getProtocolAdapter(uri)
      .get(options, res => {
        if (encoding) res.setEncoding(encoding)
        console.log(res)
        const file = createWriteStream(path)
        const total = parseInt(res.headers?.['content-length'] || '0', 10)
        let current = 0
        res
          .on('data', chunk =>
            progressCallback((current += chunk.length), total)
          )
          .pipe(file)
        file.on('finish', () => file.close(() => resolve()))
      })
      .on('error', err => {
        unlink(path)
        reject(err)
      })
  })
}

export class StatusError extends Error {
  status: number

  constructor(status: number, message: string = 'Unknown Error Occurred') {
    super(message)
    this.status = status
  }
}
