#!/usr/bin/env node

import console from 'node:console'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import DSStore from 'ds-store'

const config = JSON.parse(
  readFileSync(path.join(process.cwd(), 'src-tauri', 'tauri.conf.json'), 'utf8'),
)

const mountPath = process.argv[2]
if (!mountPath) {
  console.error('Usage: aether-dmg-metadata <mounted-volume>')
  process.exit(2)
}

const dmg = config.bundle.macOS.dmg
const store = new DSStore()

store.vSrn(1)
store.setIconSize(128)
store.setBackgroundColor(239 / 255, 251 / 255, 1)
store.setBackgroundPath(path.join(mountPath, '.background', 'dmg-background.tiff'))
store.setWindowSize(dmg.windowSize.width, dmg.windowSize.height)
store.setIconPos(`${config.productName}.app`, dmg.appPosition.x, dmg.appPosition.y)
store.setIconPos('Applications', dmg.applicationFolderPosition.x, dmg.applicationFolderPosition.y)

await new Promise((resolve, reject) => {
  store.write(path.join(mountPath, '.DS_Store'), (error) => {
    if (error) reject(error)
    else resolve()
  })
})
