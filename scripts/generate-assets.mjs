// Merges the vanilla block/model/texture assets with any mods or resource
// packs found in modset/ into public/assets/merged/.
//
// modset/ is gitignored — drop .jar mod files, resource pack .zip files, or
// already-extracted resource pack folders in there and re-run this script.
//
// Usage: node scripts/generate-assets.mjs

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import AdmZip from 'adm-zip'
import { PNG } from 'pngjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const VANILLA_DIR = join(ROOT, 'public/assets/vanilla')
const MODSET_DIR = join(ROOT, 'modset')
const OUT_DIR = join(ROOT, 'public/assets/merged')

const BLOCKSTATE_RE = /^assets\/([^/]+)\/blockstates\/(.+)\.json$/
const MODEL_RE = /^assets\/([^/]+)\/models\/(.+)\.json$/
const TEXTURE_RE = /^assets\/([^/]+)\/textures\/(.+)\.png$/

const MAX_BLOCK_TEXTURE_SIZE = 32

function readJson(path) {
	return JSON.parse(readFileSync(path, 'utf8'))
}

// Collects { name, read() } entries from either a .jar/.zip file or an
// already-extracted directory, both laid out as assets/<namespace>/...
function collectSources() {
	if (!existsSync(MODSET_DIR)) {
		return []
	}
	const sources = []
	for (const entry of readdirSync(MODSET_DIR)) {
		const fullPath = join(MODSET_DIR, entry)
		const stat = statSync(fullPath)
		if (stat.isDirectory()) {
			sources.push({ label: entry, entries: collectDirEntries(fullPath) })
		} else if (entry.endsWith('.jar') || entry.endsWith('.zip')) {
			const zip = new AdmZip(fullPath)
			const entries = zip.getEntries()
				.filter(e => !e.isDirectory)
				.map(e => ({ name: e.entryName.replace(/\\/g, '/'), read: () => e.getData() }))
			sources.push({ label: entry, entries })
		}
	}
	return sources
}

function collectDirEntries(dir) {
	const entries = []
	const walk = (current, prefix) => {
		for (const name of readdirSync(current)) {
			const full = join(current, name)
			const rel = prefix ? `${prefix}/${name}` : name
			if (statSync(full).isDirectory()) {
				walk(full, rel)
			} else {
				entries.push({ name: rel, read: () => readFileSync(full) })
			}
		}
	}
	walk(dir, '')
	return entries
}

function hasSiblingMcmeta(entryNames, textureEntryName) {
	return entryNames.has(`${textureEntryName}.mcmeta`)
}

function main() {
	const blockDefinitions = readJson(join(VANILLA_DIR, 'block_definitions.json'))
	const models = readJson(join(VANILLA_DIR, 'models.json'))
	const atlasRects = readJson(join(VANILLA_DIR, 'atlas.json'))
	const vanillaAtlas = PNG.sync.read(readFileSync(join(VANILLA_DIR, 'atlas.png')))

	const sources = collectSources()

	if (sources.length === 0) {
		console.log('modset/ is empty or missing — merged assets will be identical to vanilla.')
	}

	const newTextures = new Map() // fullId -> { width, height, data: Buffer (RGBA) }
	let blockstateCount = 0
	let modelCount = 0

	for (const source of sources) {
		const entryNames = new Set(source.entries.map(e => e.name))

		for (const entry of source.entries) {
			let match

			if ((match = BLOCKSTATE_RE.exec(entry.name))) {
				const [, namespace, name] = match
				const fullId = `${namespace}:${name}`
				if (!(name in blockDefinitions) && !(fullId in blockDefinitions)) {
					blockDefinitions[fullId] = JSON.parse(entry.read().toString('utf8'))
					blockstateCount++
				}
				continue
			}

			if ((match = MODEL_RE.exec(entry.name))) {
				const [, namespace, name] = match
				const fullId = `${namespace}:${name}`
				if (!(name in models) && !(fullId in models)) {
					try {
						models[fullId] = JSON.parse(entry.read().toString('utf8'))
						modelCount++
					} catch (error) {
						console.warn(`[${source.label}] Skipping model id: ${fullId} (${error.message})`)
						continue
					}
	
				}
				continue
			}

			if ((match = TEXTURE_RE.exec(entry.name))) {
				const [, namespace, name] = match
				const fullId = `${namespace}:${name}`
				if (name in atlasRects || fullId in atlasRects || newTextures.has(fullId)) {
					continue // already have this texture (vanilla, or an earlier source)
				}
				let png
				try {
					png = PNG.sync.read(entry.read())
				} catch (error) {
					console.warn(`[${source.label}] Skipping invalid PNG: ${entry.name} (${error.message})`)
					continue
				}
				const animated = hasSiblingMcmeta(entryNames, entry.name)
				const frameSize = animated ? Math.min(png.width, png.height) : null
				const width = frameSize ?? png.width
				const height = frameSize ?? png.height
				if (width > MAX_BLOCK_TEXTURE_SIZE || height > MAX_BLOCK_TEXTURE_SIZE) {
					continue
				}
				const data = Buffer.alloc(width * height * 4)
				for (let y = 0; y < height; y++) {
					png.data.copy(data, y * width * 4, y * png.width * 4, y * png.width * 4 + width * 4)
				}
				newTextures.set(fullId, { width, height, data })
			}
		}

		console.log(`[${source.label}] scanned (${source.entries.length} files)`)
	}

	// Shelf-pack new textures below the existing atlas, keeping its width.
	const atlasWidth = vanillaAtlas.width
	const packed = []
	let shelfX = 0
	let shelfY = vanillaAtlas.height
	let shelfHeight = 0
	const sorted = [...newTextures.entries()].sort((a, b) => b[1].height - a[1].height)
	for (const [fullId, tex] of sorted) {
		if (tex.width > atlasWidth) {
			console.warn(`Skipping ${fullId}: texture wider (${tex.width}px) than atlas (${atlasWidth}px)`)
			continue
		}
		if (shelfX + tex.width > atlasWidth) {
			shelfX = 0
			shelfY += shelfHeight
			shelfHeight = 0
		}
		packed.push({ fullId, x: shelfX, y: shelfY, ...tex })
		shelfX += tex.width
		shelfHeight = Math.max(shelfHeight, tex.height)
	}
	const finalHeight = shelfY + shelfHeight

	const mergedAtlas = new PNG({ width: atlasWidth, height: Math.max(finalHeight, vanillaAtlas.height) })
	mergedAtlas.data.fill(0)
	PNG.bitblt(vanillaAtlas, mergedAtlas, 0, 0, vanillaAtlas.width, vanillaAtlas.height, 0, 0)
	for (const tex of packed) {
		PNG.bitblt({ width: tex.width, height: tex.height, data: tex.data }, mergedAtlas, 0, 0, tex.width, tex.height, tex.x, tex.y)
		atlasRects[tex.fullId] = [tex.x, tex.y, tex.width, tex.height]
	}

	mkdirSync(OUT_DIR, { recursive: true })
	writeFileSync(join(OUT_DIR, 'block_definitions.json'), JSON.stringify(blockDefinitions))
	writeFileSync(join(OUT_DIR, 'models.json'), JSON.stringify(models))
	writeFileSync(join(OUT_DIR, 'atlas.json'), JSON.stringify(atlasRects))
	writeFileSync(join(OUT_DIR, 'atlas.png'), PNG.sync.write(mergedAtlas))

	console.log(`Added ${blockstateCount} blockstates, ${modelCount} models, ${packed.length} textures.`)
	console.log(`Atlas: ${atlasWidth}x${vanillaAtlas.height} -> ${mergedAtlas.width}x${mergedAtlas.height}`)
	console.log(`Wrote merged assets to ${OUT_DIR}`)
}

main()
