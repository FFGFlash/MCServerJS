import { IOptions } from '../shared'
import Server from './server'
import { existsSync } from 'fs'
import Versions from '../versions'
import { download } from '../request'

export default class FabricServer extends Server {
  loader?: string
  installer?: string
  #useLatestInstaller: boolean

  constructor(
    version?: string,
    loader?: string,
    options?: Partial<IFabricOptions>
  ) {
    const { installer, ...serverOptions } = Object.assign(
      structuredClone(FabricServer.DefaultOptions),
      options
    )
    super(version, serverOptions)
    this.loader = loader
    this.installer = installer
    this.#useLatestInstaller = !installer
  }

  async downloadJar(
    force?: boolean,
    progressCallback?: ((current: number, total: number) => void) | undefined
  ) {
    if (existsSync(this.jar) && !force) return
    const versions = await Versions.fabricManifest
    if (!this.version) this.version = versions.latest.release.game
    if (!this.loader) this.loader = versions.latest.release.loader
    if (this.#useLatestInstaller || !this.installer)
      this.installer = versions.latest.release.installer
    const url = `https://meta.fabricmc.net/v2/versions/loader/${this.version}/${this.loader}/${this.installer}/server/jar`
    await download(url, this.jar, undefined, progressCallback)
    await this.getVersionInfo(true)
  }
}

export interface IFabricOptions extends IOptions {
  installer: string
}
