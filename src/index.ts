import { createInterface } from 'readline/promises'
import Server from './servers/server'
import { IOptions } from './shared'
import Versions from './versions'

export { default as Server } from './servers/server'
export { default as Versions } from './versions'
export { default as Properties } from './properties'
export { default as SpigotServer } from './servers/spigotServer'

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
    Versions.servers.then(versions => {
      const releases = versions.versions
        .filter(v => v.type === 'release')
        .map(v => `Release ${v.id}`)
      const snapshots = versions.versions
        .filter(v => v.type === 'snapshot')
        .map(v => `Snapshot ${v.id}`)

      const maxLen = Math.max(releases.length, snapshots.length)
      const longRelease = releases.reduce(
        (prev, release) => Math.max(release.length, prev),
        0
      )
      const longSnapshot = snapshots.reduce(
        (prev, snapshot) => Math.max(snapshot.length, prev),
        0
      )

      const releasesHeader = 'Releases'
      const releasesHeaderBar = (longRelease - releasesHeader.length - 2) / 2
      const snapshotHeader = 'Snapshots'
      const snapshotHeaderBar = (longSnapshot - snapshotHeader.length - 2) / 2
      console.log(
        '|',
        ''.padEnd(Math.floor(releasesHeaderBar), '-'),
        releasesHeader,
        ''.padEnd(Math.ceil(releasesHeaderBar), '-'),
        '|',
        ''.padEnd(Math.floor(snapshotHeaderBar), '-'),
        snapshotHeader,
        ''.padEnd(Math.ceil(snapshotHeaderBar), '-'),
        '|'
      )
      for (let i = 0; i < maxLen; i++) {
        const release = releases[i] || ''
        const snapshot = snapshots[i] || ''
        console.log(
          '|',
          release.padEnd(longRelease),
          '|',
          snapshot.padEnd(longSnapshot),
          '|'
        )
      }
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

    server.on('download', (file, current, total) => {
      const percent = ((current / total) * 100).toFixed(2)
      const currentMB = (current / 1048576).toFixed(2)
      const totalMB = (total / 1048576).toFixed(2)
      server.log(
        `Downloading file: ${percent}% (${currentMB}mb / ${totalMB}mb)`
      )
    })

    server.on('message', message => console.log(message.content))

    server.on('stateUpdate', state => {
      if (state === 'CRASHED') console.log('Press Enter to Continue...')
      else if (state === 'STOPPED') {
        if (eula) return console.log('Do you accept the EULA? (Y/[N])')
        setTimeout(() => rl.close(), 1000)
      }
    })

    server.on('eula', () => (eula = true))

    const promptCommand = () => {
      rl.question('')
        .then(input => {
          if (!eula) {
            if (!server.canStop) return rl.close()
            const args = input.split(' ')
            const cmd = args.shift()?.toLowerCase()
            if (cmd === 'setprop') {
              server.log(`Setting property ${args[0]} to ${args[1]}`)
              return server.properties
                .setProperty(args[0], args[1])
                .then(() => server.execute('reload'))
            } else if (cmd === 'getprop') {
              return server.properties.getProperty(args[0]).then(prop => {
                if (!prop)
                  server.warn(
                    `Couldn't find a property by the name '${args[0]}'`
                  )
                else server.log(`${prop.name} is ${prop.value}`)
                return
              })
            }
            return server.execute(input)
          }
          eula = false
          return server
            .acceptEula(input.toLowerCase() === 'y')
            .then(accept => (accept ? server.start() : rl.close()))
        })
        .catch(() => {})
        .finally(promptCommand)
    }

    rl.on('close', () => process.exit(0))

    server
      .start()
      .then(() => promptCommand())
      .catch(() => {})
  }
}

type ArgReducer = {
  key?: string
  args: {
    _: Array<string | number | boolean>
    [k: string]: string | number | boolean | Array<string | number | boolean>
  }
}
