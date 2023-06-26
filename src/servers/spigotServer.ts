import path from 'path'
import Server from './server'
import { DEFAULT_JAVA_PATH, IOptions, ServerStateError } from '../shared'
import { existsSync } from 'fs'
import { download } from '../request'
import Versions from '../versions'
import { spawn } from 'child_process'
import { mkdir, rename } from 'fs/promises'

interface ISpigotOptions extends IOptions {
  buildPath: string
}

export default class SpigotServer extends Server {
  buildPath: string

  static DefaultOptions: ISpigotOptions = {
    minMemory: 256,
    softMaxMemory: 512,
    maxMemory: 1024,
    javaPath: DEFAULT_JAVA_PATH,
    path: './server',
    buildPath: './buildtools'
  }

  constructor(version?: string, options?: Partial<ISpigotOptions>) {
    const { buildPath, ...serverOptions } = Object.assign(
      structuredClone(SpigotServer.DefaultOptions),
      options
    )
    super(version, serverOptions)
    this.buildPath = buildPath
  }

  async downloadJar(
    force = false,
    progressCallback?: (current: number, total: number) => void
  ) {
    if (existsSync(this.buildtool) && !force) return
    await download(
      'https://hub.spigotmc.org/jenkins/job/BuildTools/lastSuccessfulBuild/artifact/target/BuildTools.jar',
      this.buildtool,
      undefined,
      progressCallback
    )
  }

  async buildServerJar(
    force = false,
    progressCallback?: (current: number, total: number) => void,
    buildCallback?: (data: string) => void
  ) {
    const { jar, buildPath, env, buildtool, buildArgs, buildjar } = this
    if (existsSync(jar) && !force) return
    const versions = await Versions.spigotManifest
    if (!this.version) this.version = versions.latest.release
    if (!existsSync(buildtool) || force)
      await this.downloadJar(force, progressCallback)
    const buildPromise = new Promise<void>((resolve, reject) => {
      const process = spawn('java', buildArgs, {
        cwd: buildPath,
        env,
        windowsHide: true
      })

      process.stdout.on('data', data => buildCallback?.(String(data)))

      process.on('error', err => {
        reject(`Failed to build server jar. ${err.message}`)
      })

      process.on('exit', (code, signal) => {
        if (code === null) reject(`Build process exited with signal: ${signal}`)
        else if (code !== 0) reject(`Build process exited with code: ${code}`)
        else resolve()
      })
    })
    await buildPromise
    await rename(buildjar, jar)
  }

  async start() {
    const { path, jar, env, args, buildjar, buildPath } = this
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

      //* If the jar doesn't exist then download build tools and build the jar file
      if (!isCorrectVersion) {
        if (!existsSync(buildPath)) {
          this.warn('Creating build directory...')
          await mkdir(buildPath, { recursive: true })
        }

        if (!existsSync(buildjar)) {
          this.log('Downloading build tools...')
          try {
            await this.downloadJar(true, (cur, tot) =>
              this.emit('download', buildjar, cur, tot)
            )
          } catch (err) {
            this.state = 'CRASHED'
            throw err
          }
        }

        this.log('Building server jar...')
        try {
          await this.buildServerJar(
            true,
            (cur, tot) => this.emit('download', buildjar, cur, tot),
            data => this.log(data, false)
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

  get buildtool() {
    return path.join(this.buildPath, 'BuildTools.jar')
  }

  get buildjar() {
    return path.join(this.buildPath, `spigot-${this.version || 'latest'}.jar`)
  }

  get buildArgs() {
    return ['-jar', 'BuildTools.jar', '--rev', this.version || 'latest']
  }
}
