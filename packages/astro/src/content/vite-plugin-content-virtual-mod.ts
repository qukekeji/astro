import fsMod from 'node:fs';
import * as path from 'node:path';
import type { Plugin } from 'vite';
import { normalizePath } from 'vite';
import type { AstroSettings } from '../@types/astro.js';
import { appendForwardSlash, prependForwardSlash } from '../core/path.js';
import { VIRTUAL_MODULE_ID } from './consts.js';
import { getContentEntryExts, getContentPaths, getDataEntryExts } from './utils.js';

interface AstroContentVirtualModPluginParams {
	settings: AstroSettings;
}

export function astroContentVirtualModPlugin({
	settings,
}: AstroContentVirtualModPluginParams): Plugin {
	const contentPaths = getContentPaths(settings.config);
	const relContentDir = normalizePath(
		appendForwardSlash(
			prependForwardSlash(
				path.relative(settings.config.root.pathname, contentPaths.contentDir.pathname)
			)
		)
	);
	const contentEntryExts = getContentEntryExts(settings);
	const dataEntryExts = getDataEntryExts(settings);

	const virtualModContents = fsMod
		.readFileSync(contentPaths.virtualModTemplate, 'utf-8')
		.replace('@@CONTENT_DIR@@', relContentDir)
		.replace('@@CONTENT_ENTRY_GLOB_PATH@@', `${relContentDir}**/*${getExtGlob(contentEntryExts)}`)
		.replace('@@DATA_ENTRY_GLOB_PATH@@', `${relContentDir}**/*${getExtGlob(dataEntryExts)}`)
		.replace(
			'@@RENDER_ENTRY_GLOB_PATH@@',
			`${relContentDir}**/*${getExtGlob(/** Note: data collections excluded */ contentEntryExts)}`
		);

	const astroContentVirtualModuleId = '\0' + VIRTUAL_MODULE_ID;

	return {
		name: 'astro-content-virtual-mod-plugin',
		enforce: 'pre',
		resolveId(id) {
			if (id === VIRTUAL_MODULE_ID) {
				return astroContentVirtualModuleId;
			}
		},
		load(id) {
			if (id === astroContentVirtualModuleId) {
				return {
					code: virtualModContents,
				};
			}
		},
	};
}

function getExtGlob(exts: string[]) {
	return exts.length === 1
		? // Wrapping {...} breaks when there is only one extension
		  exts[0]
		: `{${exts.join(',')}}`;
}
