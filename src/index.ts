import { createInterface } from 'readline/promises'
import Server from './server'
import { IOptions } from './shared'

export { default as Server } from './server'

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
