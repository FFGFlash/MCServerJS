# MCServerJS

MCServerJS is your javascript solution to minecraft servers, this package allows for easy server manipulation using javascript!

## Examples

### Server Example

The following example will make a fully functional server that can accept terminal input for executing commands and accepting the EULA

```js
const { Server } = require('@ffgflash/mcserver.js')
const { createInterface } = require('readline/promises')

const version = '1.19.4'
const options = {
  minMemory: 512,
  softMaxMemory: 1024,
  maxMemory: 2048,
  javaPath: 'some/path/to/java/bin',
  path: 'some/path/to/my/server'
}
const server = new Server(version, options)
const rl = createInterface({ input: process.stdin, output: process.stdout })
let eula = false

function prompt() {
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
              server.warn(`Couldn't find a property by the name '${args[0]}'`)
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
    .finally(prompt)
}

rl.on('close', () => process.exit(0))

server.on('download', (file, current, total) => {
  const percent = ((current / total) * 100).toFixed(2)
  const currentMB = (current / 1048576).toFixed(2)
  const totalMB = (total / 1048576).toFixed(2)
  server.log(`Downloading file: ${percent}% (${currentMB}mb / ${totalMB}mb)`)
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

server.start().then(() => prompt())
```

## Command Line

While MCServer.JS allows for you to control the server through code, it also comes with some nice features like downloading the server.jar and allowing you to accept the EULA without closing the terminal and opening a text editor. So for those who don't want to write a single line of code can use the command line.

```bat
mcserver.js [-versions] [--v <version>] [--mn <minMemory>] [--mx <maxMemory>] [--smx <softMaxMemory>] [--java <javaPath>] [--path <path>] [path]
```

## To-Do

- [x] Vanilla Server
  - [x] Load `server.properties`
  - [ ] Type Checking `server.properties`
- [x] Command Line Integration
- [ ] Forge Server **[High Priority]**
- [x] Fabric Server
- [x] Spigot Server
  - [ ] Load `bukkit.yml` **[Low Priority]**
  - [ ] Load `spigot.yml` **[Low Priority]**
- [ ] Download Java Builds Automatically **[High Priority]**
