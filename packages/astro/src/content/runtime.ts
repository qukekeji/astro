import { AstroError, AstroErrorData } from '../core/errors/index.js';
import { prependForwardSlash } from '../core/path.js';
import { ZodIssueCode, string as zodString, type z } from 'zod';

import {
	createComponent,
	createHeadAndContent,
	renderComponent,
	renderScriptElement,
	renderStyleElement,
	renderTemplate,
	renderUniqueStylesheet,
	unescapeHTML,
} from '../runtime/server/index.js';

type GlobResult = Record<string, () => Promise<any>>;
type CollectionToEntryMap = Record<string, GlobResult>;

export function createCollectionToGlobResultMap({
	globResult,
	dir,
}: {
	globResult: GlobResult;
	dir: string;
}) {
	const collectionToGlobResultMap: CollectionToEntryMap = {};
	for (const key in globResult) {
		const keyRelativeToDir = key.replace(new RegExp(`^${dir}`), '');
		const segments = keyRelativeToDir.split('/');
		if (segments.length <= 1) continue;
		const collection = segments[0];
		const entryId = segments.slice(1).join('/');
		collectionToGlobResultMap[collection] ??= {};
		collectionToGlobResultMap[collection][entryId] = globResult[key];
	}
	return collectionToGlobResultMap;
}

const cacheEntriesByCollection = new Map<string, any[]>();
export function createGetCollection({
	contentCollectionToEntryMap,
	dataCollectionToEntryMap,
	collectionToRenderEntryMap,
}: {
	contentCollectionToEntryMap: CollectionToEntryMap;
	dataCollectionToEntryMap: CollectionToEntryMap;
	collectionToRenderEntryMap: CollectionToEntryMap;
}) {
	return async function getCollection(collection: string, filter?: (entry: any) => unknown) {
		let type: 'content' | 'data';
		if (collection in contentCollectionToEntryMap) {
			type = 'content';
		} else if (collection in dataCollectionToEntryMap) {
			type = 'data';
		} else {
			throw new AstroError({
				...AstroErrorData.CollectionDoesNotExistError,
				message: AstroErrorData.CollectionDoesNotExistError.message(collection),
			});
		}
		const lazyImports = Object.values(
			type === 'content'
				? contentCollectionToEntryMap[collection]
				: dataCollectionToEntryMap[collection]
		);
		let entries: any[] = [];
		// Cache `getCollection()` calls in production only
		// prevents stale cache in development
		if (import.meta.env.PROD && cacheEntriesByCollection.has(collection)) {
			entries = cacheEntriesByCollection.get(collection)!;
		} else {
			entries = await Promise.all(
				lazyImports.map(async (lazyImport) => {
					const entry = await lazyImport();
					return type === 'content'
						? {
								id: entry.id,
								slug: entry.slug,
								body: entry.body,
								collection: entry.collection,
								data: entry.data,
								async render() {
									return render({
										collection: entry.collection,
										id: entry.id,
										collectionToRenderEntryMap,
									});
								},
						  }
						: {
								id: entry.id,
								collection: entry.collection,
								data: entry.data,
						  };
				})
			);
			cacheEntriesByCollection.set(collection, entries);
		}
		if (typeof filter === 'function') {
			return entries.filter(filter);
		} else {
			return entries;
		}
	};
}

export function createGetEntryBySlug({
	getCollection,
	collectionToRenderEntryMap,
}: {
	getCollection: ReturnType<typeof createGetCollection>;
	collectionToRenderEntryMap: CollectionToEntryMap;
}) {
	return async function getEntryBySlug(collection: string, slug: string) {
		// This is not an optimized lookup. Should look into an O(1) implementation
		// as it's probably that people will have very large collections.
		const entries = await getCollection(collection);
		let candidate: (typeof entries)[number] | undefined = undefined;
		for (let entry of entries) {
			if (entry.slug === slug) {
				candidate = entry;
				break;
			}
		}

		if (typeof candidate === 'undefined') {
			return undefined;
		}

		const entry = candidate;
		return {
			id: entry.id,
			slug: entry.slug,
			body: entry.body,
			collection: entry.collection,
			data: entry.data,
			async render() {
				return render({
					collection: entry.collection,
					id: entry.id,
					collectionToRenderEntryMap,
				});
			},
		};
	};
}

export function createGetDataEntryById({
	dataCollectionToEntryMap,
}: {
	dataCollectionToEntryMap: CollectionToEntryMap;
}) {
	return async function getDataEntryById(collection: string, id: string) {
		const lazyImport =
			dataCollectionToEntryMap[collection]?.[/*TODO: filePathToIdMap*/ id + '.json'];

		// TODO: AstroError
		if (!lazyImport) throw new Error(`Entry ${collection} → ${id} was not found.`);
		const entry = await lazyImport();

		return {
			id: entry.id,
			collection: entry.collection,
			data: entry.data,
		};
	};
}

async function render({
	collection,
	id,
	collectionToRenderEntryMap,
}: {
	collection: string;
	id: string;
	collectionToRenderEntryMap: CollectionToEntryMap;
}) {
	const UnexpectedRenderError = new AstroError({
		...AstroErrorData.UnknownContentCollectionError,
		message: `Unexpected error while rendering ${String(collection)} → ${String(id)}.`,
	});

	const lazyImport = collectionToRenderEntryMap[collection]?.[id];
	if (typeof lazyImport !== 'function') throw UnexpectedRenderError;

	const baseMod = await lazyImport();
	if (baseMod == null || typeof baseMod !== 'object') throw UnexpectedRenderError;

	const { collectedStyles, collectedLinks, collectedScripts, getMod } = baseMod;
	if (typeof getMod !== 'function') throw UnexpectedRenderError;
	const mod = await getMod();
	if (mod == null || typeof mod !== 'object') throw UnexpectedRenderError;

	const Content = createComponent({
		factory(result, baseProps, slots) {
			let styles = '',
				links = '',
				scripts = '';
			if (Array.isArray(collectedStyles)) {
				styles = collectedStyles.map((style: any) => renderStyleElement(style)).join('');
			}
			if (Array.isArray(collectedLinks)) {
				links = collectedLinks
					.map((link: any) => {
						return renderUniqueStylesheet(result, {
							href: prependForwardSlash(link),
						});
					})
					.join('');
			}
			if (Array.isArray(collectedScripts)) {
				scripts = collectedScripts.map((script: any) => renderScriptElement(script)).join('');
			}

			let props = baseProps;
			// Auto-apply MDX components export
			if (id.endsWith('mdx')) {
				props = {
					components: mod.components ?? {},
					...baseProps,
				};
			}

			return createHeadAndContent(
				unescapeHTML(styles + links + scripts) as any,
				renderTemplate`${renderComponent(result, 'Content', mod.Content, props, slots)}`
			);
		},
		propagation: 'self',
	});

	return {
		Content,
		headings: mod.getHeadings?.() ?? [],
		remarkPluginFrontmatter: mod.frontmatter ?? {},
	};
}

export function createReference({
	getCollectionName,
	map,
}: {
	getCollectionName(): Promise<string>;
	map: CollectionToEntryMap;
}) {
	return function reference() {
		return zodString().transform(async (entryId: string, ctx) => {
			const collectionName = await getCollectionName();
			const flattenedErrorPath = ctx.path.join('.');
			const entries = map[collectionName];
			if (!entries) {
				ctx.addIssue({
					code: ZodIssueCode.custom,
					message: `**${flattenedErrorPath}:** Reference to ${collectionName} invalid. Collection does not exist or is empty.`,
				});
				return;
			}

			const lazyImport = entries[entryId + '.json'];
			if (!lazyImport) {
				const entryKeys = Object.keys(entries).map((k) =>
					// TODO: handle hardcoded json extension
					k.replace(/\.json$/, '')
				);
				ctx.addIssue({
					code: ZodIssueCode.custom,
					message: `**${flattenedErrorPath}**: Reference to ${collectionName} invalid. Expected ${entryKeys
						.map((c) => JSON.stringify(c))
						.join(' | ')}. Received ${JSON.stringify(entryId)}.`,
				});
				return;
			}
			try {
				const entry = await lazyImport();
				if (entry._internal?.type === 'data') {
					return {
						id: entry.id,
						collection: entry.collection,
						data: entry.data,
						_internal: entry._internal,
					};
				} else {
					return {
						id: entry.id,
						slug: entry.slug,
						body: entry.body,
						collection: entry.collection,
						data: entry.data,
						_internal: entry._internal,
					};
				}
			} catch (e) {
				// Catch schema parse errors for referenced content.
				if (e instanceof Error && (e as any).type === 'AstroError') {
					// `isHoistedAstroError` will be handled where the schema is parsed.
					// @see "./utils.ts" -> getEntryData()
					ctx.addIssue({
						code: ZodIssueCode.custom,
						params: {
							isHoistedAstroError: true,
							astroError: e,
						},
					});
				} else {
					ctx.addIssue({
						code: ZodIssueCode.custom,
						message: `**${flattenedErrorPath}:** Referenced entry ${collectionName} → ${entryId} is invalid.`,
					});
				}
			}
		});
	};
}
