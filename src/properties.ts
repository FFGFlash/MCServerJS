import { existsSync } from 'fs'
import { readFile, writeFile } from 'fs/promises'
import { EOL } from 'os'

export interface IProperty {
  name: string
  value: string
}

export type PropertyData = IProperty | null | string

export default class Properties {
  #data: PropertyData[] = []
  static PropertyPattern = /^\s*(?!#)(.+)=(.*)$/i
  static CommentPattern = /^#.+$/i

  path: string

  constructor(path: string) {
    this.path = path
  }

  async loadProperties() {
    const content = await readFile(this.path, 'utf-8')
    const data = content.replace(/\r?\n/gm, '\n').split('\n')
    this.#data = data.map<PropertyData>(line => {
      if (Properties.CommentPattern.test(line)) return line
      const match = line.match(Properties.PropertyPattern)
      if (match) return { name: match[1], value: match[2] }
      return null
    })
  }

  async getProperty(name: string) {
    const properties = await this.getProperties()
    return properties.find(prop => prop.name === name)
  }

  async getProperties() {
    if (this.#data.length === 0 && existsSync(this.path))
      await this.loadProperties()
    return this.#data.filter<IProperty>(
      (line): line is IProperty => line !== null && typeof line !== 'string'
    )
  }

  async setProperty(name: string, value: string) {
    const properties = await this.setProperties([{ name, value }])
    return properties.find(prop => prop.name === name)
  }

  async setProperties(properties: IProperty[]) {
    const newData = this.#data.map(line => {
      if (!line || typeof line === 'string') return line
      return properties.find(prop => prop.name === line.name) || line
    })
    const content = newData
      .map<string>(line => {
        if (!line) line = ''
        else if (typeof line === 'object') line = `${line.name}=${line.value}`
        return line
      })
      .join(EOL)
    await writeFile(this.path, content, 'utf-8')
    this.#data = newData
    return this.#data.filter<IProperty>(
      (line): line is IProperty => line !== null && typeof line !== 'string'
    )
  }
}
