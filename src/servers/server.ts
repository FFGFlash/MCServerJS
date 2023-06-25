import { ChildProcess, exec as execCallback, spawn } from 'child_process'
import EventEmitter from 'events'
import { existsSync } from 'fs'
import { mkdir, readFile, writeFile } from 'fs/promises'
import { EOL } from 'os'
import path from 'path'
import {
  DEFAULT_JAVA_PATH,
  IOptions,
  IServerLog,
  ServerStateError,
  ServerStatus
} from '../shared'
import { download, request } from '../request'
import Versions, { IVersion, IVersionManifest } from '../versions'
import Properties from '../properties'
import { promisify } from 'util'

const exec = promisify(execCallback)

export interface IServerVersionInfo {
  id: string
  name: string
  world_version?: number
  series_id?: string
  protocol_version?: number
  pack_version?: {
    resource?: number
    data?: number
  }
  build_time?: string
  java_component?: string
  java_version?: number
  stable?: boolean
}

export interface ServerEvents {
  stateUpdate: (state: ServerStatus) => void
  message: (message: IServerLog) => void
  eula: () => void
  download: (file: string, current: number, total: number) => void
}

export interface Server {
  on<U extends keyof ServerEvents>(event: U, listener: ServerEvents[U]): this
  once<U extends keyof ServerEvents>(event: U, listener: ServerEvents[U]): this
  emit<U extends keyof ServerEvents>(
    event: U,
    ...args: Parameters<ServerEvents[U]>
  ): boolean
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
  properties: Properties

  protected process?: ChildProcess
  static PrefixPattern = /(\[\d+:\d+:\d+\] \[(?:ServerMain|Server thread)\/)/g
  static DonePattern =
    /\[\d+:\d+:\d+\] \[(ServerMain|Server thread)\/INFO\]: Done \([^)]+\)!/i
  static StopPattern =
    /\[\d+:\d+:\d+\] \[(ServerMain|Server thread)\/INFO\]: Stopping server/i
  static EulaPattern =
    /\[\d+:\d+:\d+\] \[(ServerMain|Server thread)\/INFO\]: You need to agree to the EULA in order to run the server\. Go to eula.txt for more info\.(?:\n|\r\n)?/i
  static WarnPattern = /\/WARN\]/i
  static ErrorPattern = /\/ERROR\]/i

  static DefaultOptions: IOptions = {
    minMemory: 256,
    softMaxMemory: 512,
    maxMemory: 1024,
    javaPath: DEFAULT_JAVA_PATH,
    path: './server'
  }

  constructor(version?: string, options?: Partial<IOptions>) {
    super()
    const { minMemory, maxMemory, softMaxMemory, javaPath, path } =
      Object.assign(Server.DefaultOptions, options)

    this.version = version
    this.minMemory = minMemory
    this.softMaxMemory = softMaxMemory
    this.maxMemory = maxMemory
    this.javaPath = javaPath
    this.path = path
    this.properties = new Properties(this.prop)
  }

  async buildJar(
    force = false,
    progressCallback?: (current: number, total: number) => void
  ) {
    if (existsSync(this.jar) && !force) return
    const versions = await Versions.servers
    if (!this.version) this.version = versions.latest.release
    const versionInfo = versions.versions.find(v => v.id === this.version)
    if (!versionInfo) throw new Error('Unable to find version info.')
    const version = await request<IVersion>(versionInfo.url)
    if ('status' in version)
      throw new Error('Failed to download version from version info')
    if (!version.downloads.server)
      throw new Error("The version provided doesn't have a server jar")
    await download(
      version.downloads.server.url,
      this.jar,
      undefined,
      progressCallback
    )
    await this.getVersionInfo(true)
  }

  async getVersionInfo(force = false): Promise<IServerVersionInfo | undefined> {
    const { path, env, info, jar } = this
    if (!this.version) {
      const manifest = await Versions.servers
      this.version = manifest.latest.release
    }
    if (!existsSync(jar)) return
    if (!existsSync(info) || force) {
      const { stdout } = await exec('jar -xvf server.jar version.json', {
        env,
        cwd: path,
        windowsHide: true
      })
      if (!stdout) {
        const versionInfo = { id: this.version, name: this.version }
        await writeFile(info, JSON.stringify(versionInfo, null, 2), 'utf-8')
        return versionInfo
      }
    }
    const content = await readFile(info, 'utf-8')
    const data = JSON.parse(content) as IServerVersionInfo
    return data
  }

  async validateVersion() {
    const info = await this.getVersionInfo()
    return this.version === info?.id
  }

  async hasDatapackSupport() {
    const info = await this.getVersionInfo()
    return info?.pack_version?.data !== undefined
  }

  async hasResourcePackSupport() {
    const info = await this.getVersionInfo()
    return info?.pack_version?.resource !== undefined
  }

  async start() {
    const { path, jar, env, args } = this
    try {
      if (!this.canStart) throw new ServerStateError(this.state)
      this.state = 'STARTING'
      this.log('Attempting to start server...')

      //* If the server directory doesn't exist then create the directory
      if (!existsSync(path)) {
        this.warn('Creating server directory...')
        await mkdir(path, { recursive: true })
      }

      const isCorrectVersion = await this.validateVersion()

      //* If the jar doesn't exist then download the jar file
      if (!isCorrectVersion) {
        this.log('Downloading server jar...')
        try {
          await this.buildJar(true, (cur, tot) =>
            this.emit('download', jar, cur, tot)
          )
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
            this.log('Loading properties...')
            this.properties
              .loadProperties()
              .then(() => this.log('Successfully loaded properties.'))
              .catch(() => this.error('Failed to load properties.'))
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
    await readFile(this.eula, 'utf-8').then(content =>
      writeFile(
        this.eula,
        content.replace(/eula=(true|false)/gim, `eula=${accept}`),
        'utf-8'
      )
    )
    return accept
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

  get info() {
    return path.join(this.path, 'version.json')
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
}

export default Server
