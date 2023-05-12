import path from 'path'

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

export class ServerStateError extends Error {
  constructor(state: ServerStatus) {
    super(
      `Illegal Action: The server is currently ${state.toLocaleLowerCase()}.`
    )
  }
}
