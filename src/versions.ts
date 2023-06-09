import { existsSync } from 'fs'
import { request } from './request'
import { readFile, writeFile } from 'fs/promises'

export interface IVersionRule {
  action: 'allow' | 'disallow'
  features?: Record<string, boolean>
  os?: Record<string, string>
}

export interface IVersionLibrary {
  downloads: {
    artifact?: IVersionLibraryDownload
    classifiers?: Record<string, IVersionLibraryDownload>
  }
  extract?: { exclude: string[] }
  name: string
  natives?: Record<string, string>
  rules?: IVersionRule[]
}

export interface IVersionArgument {
  rules: IVersionRule[]
  value: string | string[]
}

export type VersionArgument = IVersionArgument | string

export type VersionType = 'release' | 'snapshot' | 'old_beta' | 'old_alpha'

export interface IVersionDownload {
  sha1: string
  size: number
  url: string
}

export interface IVersionLibraryDownload extends IVersionDownload {
  path: string
}

export interface IVersion {
  arguments: Record<string, VersionArgument[]>
  assetIndex: {
    id: string
    sha1: string
    size: number
    totalSize: number
    url: string
  }
  assets: string
  complianceLevel: number
  downloads: {
    client: IVersionDownload
    client_mappings?: IVersionDownload
    server?: IVersionDownload
    server_mappings?: IVersionDownload
    windows_server?: IVersionDownload
  }
  id: string
  javaVersion: {
    component: string
    majorVersion: number
  }
  libraries: IVersionLibrary[]
  logging?: {
    client: {
      argument: string
      file: {
        id: string
        sha1: string
        size: number
        url: string
      }
      type: string
    }
  }
  mainClass: string
  minecraftArguments?: string
  minimumLauncherVersion: number
  releaseTime: string
  time: string
  type: VersionType
}

export interface IVersionInfo {
  id: string
  type: VersionType
  url: string
  time: string
  releaseTime: string
  sha1: string
  complianceLevel: 0 | 1
}

export interface IFabricGame {
  version: string
  stable: boolean
}

export interface IFabricMapping {
  gameVersion: string
  seperator: string
  build: number
  maven: string
  version: string
  stable: boolean
}

export interface IFabricIntermediary {
  maven: string
  version: string
  stable: boolean
}

export interface IFabricLoader {
  seperator: string
  build: number
  maven: string
  version: string
  stable: boolean
}

export interface IFabricInstaller {
  url: string
  maven: string
  version: string
  stable: boolean
}

export interface IFabricVersion {
  game: IFabricGame[]
  mappings: IFabricMapping[]
  loader: IFabricLoader[]
  intermediary: IFabricIntermediary[]
  installer: IFabricInstaller[]
}

export interface IVersionManifest {
  latest: { release: string; snapshot: string }
  versions: IVersionInfo[]
}

export interface ISpigotVersionManifest {
  latest: { release: string }
  versions: string[]
}

export interface IFabricVersionManifest {
  latest: {
    release: {
      game: string
      mapping: string
      intermediary: string
      loader: string
      installer: string
    }
  }
  versions: IFabricVersion
}

export default class Versions {
  private static spigotManifestVersionRegex =
    /^<a href="(\d+\.\d+(?:\.\d)?)\.json">/gim

  static #fabricManifest?: Promise<IFabricVersionManifest>
  static #spigotManifest?: Promise<ISpigotVersionManifest>
  static #manifest?: Promise<IVersionManifest>
  static #versions?: Record<
    string,
    {
      hasClientMappings: boolean
      hasServer: boolean
      hasServerMappings: boolean
    }
  >

  private static async save() {
    await writeFile(
      './versions.json',
      JSON.stringify(this.#versions, null, 2),
      'utf-8'
    )
  }

  private static async load(): Promise<
    Record<
      string,
      {
        hasClientMappings: boolean
        hasServer: boolean
        hasServerMappings: boolean
      }
    >
  > {
    if (!existsSync('./versions.json')) return {}
    const rawData = await readFile('./versions.json', 'utf-8')
    const data = JSON.parse(rawData)
    return data
  }

  private static async getVersionData(manifest: IVersionManifest) {
    if (!this.#versions) this.#versions = await this.load()
    const versionData = this.#versions
    const filteredInfo = manifest.versions.filter(
      info => versionData[info.id] === undefined
    )
    if (filteredInfo.length) {
      const versions = await Promise.all(
        filteredInfo.map(info => request<IVersion>(info.url))
      )
      versions.forEach(version => {
        versionData[version.id] = {
          hasClientMappings: !!version.downloads.client_mappings,
          hasServer: !!version.downloads.server,
          hasServerMappings: !!version.downloads.server_mappings
        }
      })
      await this.save()
    }
    return this.#versions
  }

  static get servers(): Promise<IVersionManifest> {
    return this.manifest.then(async manifest => {
      const versionData = await this.getVersionData(manifest)
      const versions = manifest.versions.filter(
        info => versionData[info.id].hasServer
      )
      return {
        latest: {
          release: versions.find(v => v.type === 'release')?.id || '',
          snapshot: versions.find(v => v.type === 'snapshot')?.id || ''
        },
        versions
      }
    })
  }

  static get serverMappings(): Promise<IVersionManifest> {
    return this.manifest.then(async manifest => {
      const versionData = await this.getVersionData(manifest)
      const versions = manifest.versions.filter(
        info => versionData[info.id].hasServerMappings
      )
      return {
        latest: {
          release: versions.find(v => v.type === 'release')?.id || '',
          snapshot: versions.find(v => v.type === 'snapshot')?.id || ''
        },
        versions
      }
    })
  }

  static get clientMappings(): Promise<IVersionManifest> {
    return this.manifest.then(async manifest => {
      const versionData = await this.getVersionData(manifest)
      const versions = manifest.versions.filter(
        info => versionData[info.id].hasClientMappings
      )
      return {
        latest: {
          release: versions.find(v => v.type === 'release')?.id || '',
          snapshot: versions.find(v => v.type === 'snapshot')?.id || ''
        },
        versions
      }
    })
  }

  static get manifest() {
    if (!this.#manifest)
      this.#manifest = request<IVersionManifest>(
        'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'
      )
    return this.#manifest
  }

  static get spigotManifest() {
    if (!this.#spigotManifest) {
      this.#spigotManifest = request<string>(
        'https://hub.spigotmc.org/versions/'
      ).then(content => {
        const versions = []
        let match
        while ((match = this.spigotManifestVersionRegex.exec(content)) !== null)
          versions.push(match[1])
        versions.sort((a, b) => {
          const [aMajor, aMinor, aPatch] = a.split('.').map(v => Number(v))
          const [bMajor, bMinor, bPatch] = b.split('.').map(v => Number(v))
          return (
            bMajor - aMajor || bMinor - aMinor || (bPatch || 0) - (aPatch || 0)
          )
        })
        return {
          latest: { release: versions[0] },
          versions
        }
      })
    }
    return this.#spigotManifest
  }

  static get fabricManifest() {
    if (!this.#fabricManifest) {
      this.#fabricManifest = request<IFabricVersion>(
        'https://meta.fabricmc.net/v2/versions'
      ).then(versions => {
        const manifest: IFabricVersionManifest = {
          latest: {
            release: {
              game: versions.game.filter(v => v.stable)[0]?.version || '',
              mapping:
                versions.mappings.filter(v => v.stable)[0]?.version || '',
              intermediary:
                versions.intermediary.filter(v => v.stable)[0]?.version || '',
              installer:
                versions.installer.filter(v => v.stable)[0]?.version || '',
              loader: versions.loader.filter(v => v.stable)[0]?.version || ''
            }
          },
          versions
        }

        return manifest
      })
    }
    return this.#fabricManifest
  }

  static getFabricLoaders(version: string) {}
}
