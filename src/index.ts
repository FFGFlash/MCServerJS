import { ChildProcess, spawn } from 'child_process'
import EventEmitter from 'events'
import { createWriteStream, existsSync } from 'fs'
import { mkdir, readFile, unlink, writeFile } from 'fs/promises'
import http from 'http'
import https from 'https'
import { EOL } from 'os'
import path from 'path'
import { createInterface } from 'readline/promises'

const Protocols = { http, https }
function getProtocolAdapter(url: string | URL) {
  if (typeof url === 'string') url = new URL(url)
  return Protocols[url.protocol.slice(0, -1) as 'http' | 'https']
}

/** The system path to the java executable installed by the user  */
export const DEFAULT_JAVA_PATH =
  process.env.JAVA_HOME && path.join(process.env.JAVA_HOME, 'bin')

export interface IOptions {
  minMemory: number
  softMaxMemory: number
  maxMemory: number
  javaPath: string
  path: string
}

export type LogType = 'ERROR' | 'WARN' | 'INFO'

export interface IServerLog {
  type: LogType
  content: string
}

export type ServerStatus =
  | 'STOPPED'
  | 'CRASHED'
  | 'STARTING'
  | 'RUNNING'
  | 'STOPPING'

export interface IVersion {
  id: string
  type: 'release' | 'snapshot'
  url: string
  time: string
  releaseTime: string
  sha1: string
  complianceLevel: 0 | 1
}

export interface IVersions {
  latest: { release: string; snapshot: string }
  versions: IVersion[]
}

export interface ServerEvents {
  stateUpdate: (state: ServerStatus) => void
  message: (message: IServerLog) => void
  eula: () => void
}

export interface Server {
  on<U extends keyof ServerEvents>(event: U, listener: ServerEvents[U]): this
  once<U extends keyof ServerEvents>(event: U, listener: ServerEvents[U]): this
  emit<U extends keyof ServerEvents>(
    event: U,
    ...args: Parameters<ServerEvents[U]>
  ): boolean
}

async function request(url: string) {
  let data
  try {
    const res = await fetch(url)
    data = await res.json()
    if ((!data || !data.status) && !res.ok)
      data = { status: res.status, message: res.statusText }
  } catch (err: any) {
    data = { status: -1, message: err.message || 'Fetch Request Failed' }
  }
  if (data.status) throw new StatusError(data.status, data.message)
  return data
}

function download(url: string, path: string) {
  return new Promise<void>(async (resolve, reject) => {
    getProtocolAdapter(url)
      .get(url, res => {
        const file = createWriteStream(path)
        res.pipe(file)
        file.on('finish', () => file.close(() => resolve()))
      })
      .on('error', err => {
        unlink(path)
        reject(err)
      })
  })
}

export class Server extends EventEmitter {
  version?: string
  minMemory: number
  softMaxMemory: number
  maxMemory: number
  javaPath: string
  path: string
  #state: ServerStatus = 'STOPPED'
  #logs: IServerLog[] = []

  private process?: ChildProcess
  static #Versions?: Promise<IVersions>
  static PrefixPattern = /(\[\d+:\d+:\d+\] \[(?:ServerMain|Server thread)\/)/g
  static DonePattern =
    /\[\d+:\d+:\d+\] \[(ServerMain|Server thread)\/INFO\]: Done \([^)]+\)!/i
  static StopPattern =
    /\[\d+:\d+:\d+\] \[(ServerMain|Server thread)\/INFO\]: Stopping server/i
  static EulaPattern =
    /\[\d+:\d+:\d+\] \[(ServerMain|Server thread)\/INFO\]: You need to agree to the EULA in order to run the server\. Go to eula.txt for more info\.(?:\n|\r\n)?/i
  static WarnPattern = /\/WARN\]/i
  static ErrorPattern = /\/ERROR\]/i
  static PropertyPattern = /^\s*(?!#)(.+)=(.*)$/i
  static CommentPattern = /^#.+$/i

  constructor(version?: string, options?: Partial<IOptions>) {
    super()
    const { minMemory, maxMemory, softMaxMemory, javaPath, path } =
      Object.assign(
        {
          minMemory: 256,
          softMaxMemory: 512,
          maxMemory: 1024,
          javaPath: DEFAULT_JAVA_PATH,
          path: './server'
        } as IOptions,
        options
      )

    this.version = version
    this.minMemory = minMemory
    this.softMaxMemory = softMaxMemory
    this.maxMemory = maxMemory
    this.javaPath = javaPath
    this.path = path
  }

  async start() {
    const { path, jar, env, args } = this
    try {
      if (!this.canStart) throw new ServerStateError(this.state)
      this.state = 'STARTING'
      this.log('Attempting to start server...')

      //* Get the list of versions
      const versions = await Server.Versions

      //* Get the version info for the server version
      if (!this.version) this.version = versions.latest.release
      const versionInfo = versions.versions.find(v => v.id === this.version)

      if (!versionInfo) {
        this.state = 'CRASHED'
        throw new Error('Unable to find version info.')
      }

      //* If the server directory doesn't exist then create the directory
      if (!existsSync(path)) {
        this.warn('Creating server directory...')
        await mkdir(path, { recursive: true })
      }

      //* If the jar doesn't exist then download the jar file
      if (!existsSync(jar)) {
        this.warn('Downloading server jar...')
        //* Fetch the version from the versionInfo
        const version = await request(versionInfo.url)

        if ('status' in version) {
          this.state = 'CRASHED'
          throw new Error('Failed to download version from version info')
        }

        try {
          await download(version.downloads.server.url, jar)
        } catch (err) {
          this.state = 'CRASHED'
          throw err
        }
      }

      this.log('Starting child process...')
      const process = spawn('java', args, { env, cwd: path, windowsHide: true })

      process.on('error', err => {
        this.error(`Failed to start the server. ${err.message}`)
        this.state = 'CRASHED'
      })

      //* Message Handler
      process.stdout.on('data', data => {
        //* Create an array of the messages received
        const messages = String(data)
          .replace(Server.PrefixPattern, '\n$&')
          .split('\n')
          .filter(m => !!m)
        //* Loop over the messages
        messages.forEach(message => {
          //* Determine if the message was a warning, error or info
          Server.WarnPattern.test(message)
            ? this.warn(message, false)
            : Server.ErrorPattern.test(message)
            ? this.error(message, false)
            : this.log(message, false)
          //* Check if the message is a key message (done, stop or eula)
          if (Server.DonePattern.test(message)) {
            this.log('Server is running...')
            this.state = 'RUNNING'
          } else if (Server.StopPattern.test(message)) {
            this.log('Server is stopping...')
            this.state = 'STOPPING'
          } else if (Server.EulaPattern.test(message)) {
            this.warn(
              'Server was unable to start, the user must accept the EULA...'
            )
            this.state = 'STOPPING'
            this.emit('eula')
          }
        })
      })

      //* Handle server shutdown
      process.on('exit', (code, signal) => {
        this.state = code === 0 ? 'STOPPED' : 'CRASHED'
        if (code === null) this.error(`Server exited with signal: ${signal}`)
        else if (code !== 0) this.error(`Server exited with code: ${code}`)
        else this.log('Server Stopped')
        this.process = undefined
      })

      this.process = process
    } catch (err: any) {
      this.error(err.message)
      throw err
    }
  }

  async execute(command: string) {
    try {
      if (!this.canStop) throw new ServerStateError(this.state)
      this.log(command)
      this.process?.stdin?.write(command)
      this.process?.stdin?.write(EOL)
    } catch (err: any) {
      this.error(err.message)
      throw err
    }
  }

  async stop() {
    try {
      if (!this.canStop) throw new ServerStateError(this.state)
      this.log('Attempting to stop the server...')
      this.process?.stdin?.write('stop')
      this.process?.stdin?.write(EOL)
    } catch (err: any) {
      this.error(err.message)
      throw err
    }
  }

  async quit() {
    if (this.canStart) return
    while (!this.canStop) continue
    this.process?.stdin?.write('stop')
    this.process?.stdin?.write(EOL)
  }

  async acceptEula(accept: boolean) {
    if (!accept) return
    await readFile(this.eula, 'utf-8').then(content =>
      writeFile(this.eula, content.replace('eula=false', 'eula=true'), 'utf-8')
    )
    return this.start()
  }

  error(message: string, prefix = true) {
    if (prefix)
      message = `[${new Date().toLocaleTimeString(undefined, {
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      })}] [MCServerJS] ${message}`
    const log = { content: message, type: 'ERROR' } as IServerLog
    this.emit('message', log)
    return this.#logs.push(log)
  }

  warn(message: string, prefix = true) {
    if (prefix)
      message = `[${new Date().toLocaleTimeString(undefined, {
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      })}] [MCServerJS] ${message}`
    const log = { content: message, type: 'WARN' } as IServerLog
    this.emit('message', log)
    return this.#logs.push(log)
  }

  log(message: string, prefix = true) {
    if (prefix)
      message = `[${new Date().toLocaleTimeString(undefined, {
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      })}] [MCServerJS] ${message}`
    const log = { content: message, type: 'INFO' } as IServerLog
    this.emit('message', log)
    return this.#logs.push(log)
  }

  get env() {
    return {
      ...process.env,
      path: `${this.javaPath};${process.env.path}`
    }
  }

  get args() {
    return [
      `-Xms${this.minMemory}M`,
      `-XX:SoftMaxHeapSize=${this.softMaxMemory}M`,
      `-Xmx${this.maxMemory}M`,
      '-jar',
      'server.jar',
      '--nogui'
    ]
  }

  get jar() {
    return path.join(this.path, 'server.jar')
  }

  get eula() {
    return path.join(this.path, 'eula.txt')
  }

  get prop() {
    return path.join(this.path, 'server.properties')
  }

  get state() {
    return this.#state
  }

  set state(state: ServerStatus) {
    this.#state = state
    this.emit('stateUpdate', this.#state)
  }

  get canStart() {
    return this.state === 'STOPPED' || this.state === 'CRASHED'
  }

  get canStop() {
    return this.state === 'RUNNING'
  }

  static get Versions() {
    if (!this.#Versions) {
      this.#Versions = request(
        'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'
      )
    }
    return this.#Versions
  }
}

export default Server

export class ServerStateError extends Error {
  constructor(state: ServerStatus) {
    super(
      `Illegal Action: The server is currently ${state.toLocaleLowerCase()}.`
    )
  }
}

export class StatusError extends Error {
  status: number

  constructor(status: number, message: string = 'Unknown Error Occurred') {
    super(message)
    this.status = status
  }
}

if (require.main === module) {
  const parseArg = (arg: string) => {
    const num = Number(arg)
    const isNum = !isNaN(num)
    const isBool = arg === 'true' || arg === 'false'
    const bool = arg === 'true'
    return isNum ? num : isBool ? bool : arg
  }

  const { argv } = process
  const { args } = argv.splice(2).reduce<ArgReducer>(
    ({ key, args }, arg, i, arr) => {
      if (arg.startsWith('--')) {
        if (key) args[key] = true
        key = arg.slice(2)
      } else if (arg.startsWith('-')) {
        if (key) {
          args[key] = true
          key = undefined
        }
        args[arg.slice(1)] = true
      } else if (key) {
        args[key] = parseArg(arg)
        key = undefined
      } else args._.push(parseArg(arg))

      if (i === arr.length - 1 && key) {
        args[key] = true
        key = undefined
      }

      return { key, args }
    },
    { args: { _: [] } }
  )

  if (args.versions) {
    Server.Versions.then(versions => {
      console.log('Latest Release:', versions.latest.release)
      console.log('Latest Snapshot:', versions.latest.snapshot)
      console.log('\n')
      console.log('--- Releases ---')
      versions.versions
        .filter(v => v.type === 'release')
        .forEach(v => console.log('Release', v.id))
      console.log('\n')
      console.log('--- Snapshots ---')
      versions.versions
        .filter(v => v.type === 'release')
        .forEach(v => console.log('Snapshot', v.id))
    })
  } else {
    let version = args.v ? String(args.v) : undefined
    const options: Partial<IOptions> = {}

    if (args.mn) options.minMemory = Number(args.mn)
    if (args.mx) options.maxMemory = Number(args.mx)
    if (args.smx) options.softMaxMemory = Number(args.smx)
    if (args.java) options.javaPath = String(args.java)
    if (args.path || args._[0]) options.path = String(args.path || args._[0])

    const rl = createInterface({ input: process.stdin, output: process.stdout })
    const server = new Server(version, options)
    let eula = false

    server.on('message', message => console.log(message.content))

    server.on('stateUpdate', state => {
      if (state === 'CRASHED') console.log('Press Enter to Continue...')
      else if (state === 'STOPPED') {
        if (eula) console.log('Do you accept the EULA? (Y/[N])')
        else setTimeout(() => rl.close(), 1000)
      }
    })

    server.on('eula', () => (eula = true))

    const promptCommand = () => {
      rl.question('')
        .then(input => {
          if (!eula) return server.execute(input)
          eula = false
          return server.acceptEula(input.toLowerCase() === 'y')
        })
        .catch(err => console.error(err.message))
        .finally(promptCommand)
    }

    rl.on('close', () => process.exit(0))

    server
      .start()
      .then(() => promptCommand())
      .catch(err => console.error(err))
  }
}

type ArgReducer = {
  key?: string
  args: {
    _: Array<string | number | boolean>
    [k: string]: string | number | boolean | Array<string | number | boolean>
  }
}
