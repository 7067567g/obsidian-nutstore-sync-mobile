import { JSX } from 'solid-js'
import { createStore, reconcile } from 'solid-js/store'
import { DelegatedEvents, delegateEvents, render } from 'solid-js/web'

export interface MountController<T> {
	update: (next: T) => void
	destroy: () => void
}

export interface MountOptions<T> {
	/**
	 * Optional boundary normalizer, applied to the initial props and to every
	 * `update` before the store reconciles. Callers use it to detach props from
	 * canonical caches (so `reconcile` can never mutate the cache in place) and
	 * to give list items stable reconcile keys.
	 */
	prepareProps?: (props: T) => T
}

export function createMount<T extends object>(
	Component: (props: T) => JSX.Element,
	el: Element,
	initialProps: T,
	options?: MountOptions<T>,
): MountController<T> {
	delegateEvents(Array.from(DelegatedEvents), el.ownerDocument ?? document)

	const prepare = options?.prepareProps
	const prepareProps = (props: T) => (prepare ? prepare(props) : props)

	let setState!: (next: T) => void

	const destroy = render(() => {
		const [state, set] = createStore(prepareProps(initialProps))
		setState = (next) => set(reconcile(prepareProps(next)))
		return <Component {...state} />
	}, el)

	return {
		update: (next) => setState(next),
		destroy,
	}
}
