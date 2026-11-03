/**
 * Build-time constants are inlined by the esbuild `define` map (see
 * `esbuild.config.mjs`), which carries the same public fallbacks as
 * `scripts/release-local.mjs` and `构建与安装.sh`. A define value can still be
 * `undefined` when this module is evaluated outside a bundle (unit tests, a
 * misconfigured build, or `JSON.stringify(undefined)`), so validate the value
 * at runtime and fall back to the documented default instead of exporting
 * `undefined`.
 */
function buildConstant(value: unknown, fallback: string): string {
	return typeof value === 'string' && value.length > 0 ? value : fallback
}

export const DEFAULT_NS_NSDAV_ENDPOINT = buildConstant(
	process.env.NS_NSDAV_ENDPOINT,
	'https://dav.jianguoyun.com/nsdav',
)
export const DEFAULT_NS_DAV_ENDPOINT = buildConstant(
	process.env.NS_DAV_ENDPOINT,
	'https://dav.jianguoyun.com/dav',
)
// `PLUGIN_VERSION` has no public fallback (a wrong version would misreport the
// build), so keep the type-only non-null assertion and rely on the define.
export const PLUGIN_VERSION = process.env.PLUGIN_VERSION!
export const LLM_GATEWAY_CLIENT_ID = buildConstant(
	process.env.LLM_GATEWAY_CLIENT_ID,
	'dc_obsidian_dp0gymrn',
)
export const NUTSTORE_LLM_GATEWAY_PROVIDER_ID = 'nutstore-llm-gateway'

export const IN_DEV = process.env.NODE_ENV === 'development'
