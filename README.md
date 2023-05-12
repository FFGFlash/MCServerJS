# MCServerJS

MCServerJS is your javascript solution to minecraft servers, this package allows for easy server manipulation using javascript!

## Example

The following example will make a fully functional server that can accept terminal input for executing commands and accepting the EULA

```js
const { Server } = require('mcserver.js')
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
      if (!server.canStop) return rl.close()
      if (!eula) return server.execute(input)
      eula = false
      return server.acceptEula(input.toLowerCase() === 'y')
    })
    .catch(() => {})
    .finally(prompt)
}

rl.on('close', () => process.exit(0))

server.on('message', message => console.log(message.type, message.content))

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
- [x] Command Line Integration
- [ ] Load `server.properties`
- [ ] Type Checking `server.properties`
- [ ] Forge Server
- [ ] Fabric Server
- [ ] Spigot Server
