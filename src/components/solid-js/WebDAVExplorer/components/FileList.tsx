import { Notice } from 'obsidian'
import { createEffect, createSignal, For, Show } from 'solid-js'
import { type fs } from '../fs'
import File from './File'
import Folder from './Folder'

export interface FileStat {
	path: string
	basename: string
	isDir: boolean
}

export interface FileListProps {
	path: string
	fs: fs
	onClick: (file: FileStat) => void
}

/**
 * Returns a directory-first, name-sorted copy of `items`.
 * Sorting a copy keeps the caller's array (which may be reactive state) intact;
 * `Array.prototype.sort` sorts in place and must not mutate the input here.
 */
export function sortedFileStats(items: FileStat[]): FileStat[] {
	return [...items].sort((a, b) => {
		if (a.isDir === b.isDir) {
			return a.basename.localeCompare(b.basename, ['zh'])
		}
		if (a.isDir && !b.isDir) {
			return -1
		}
		return 1
	})
}

export function createFileList() {
	const [version, setVersion] = createSignal(0)
	return {
		refresh() {
			setVersion((version) => version + 1)
		},
		FileList(props: FileListProps) {
			const [items, setItems] = createSignal<FileStat[]>([])

			const sortedItems = () => sortedFileStats(items())

			async function refresh() {
				try {
					const items = await props.fs.ls(props.path)
					setItems(items)
				} catch (e) {
					if (e instanceof Error) {
						new Notice(e.message)
					}
				}
			}

			createEffect(() => {
				if (version() === 0) {
					void refresh()
					return
				}
				setVersion(0)
			})

			return (
				<For each={sortedItems()}>
					{(f) => (
						<Show when={f.isDir} fallback={<File name={f.basename} />}>
							<Folder
								name={f.basename}
								path={f.path}
								onClick={() => props.onClick(f)}
							/>
						</Show>
					)}
				</For>
			)
		},
	}
}
