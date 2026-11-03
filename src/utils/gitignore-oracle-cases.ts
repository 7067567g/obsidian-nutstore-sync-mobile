import { BASIC_ENV_CASES } from './gitignore-oracle-cases-basic'
import { GLOB_OP_CASES_A } from './gitignore-oracle-cases-glob-a'
import { GLOB_OP_CASES_B } from './gitignore-oracle-cases-glob-b'
import { GLOBSTAR_CASES } from './gitignore-oracle-cases-globstar'
import { PATH_ANCHOR_CASES } from './gitignore-oracle-cases-path'
import { REINCLUSION_CASES } from './gitignore-oracle-cases-reinclude'

export { BASIC_ENV_CASES } from './gitignore-oracle-cases-basic'
export { GLOBSTAR_CASES } from './gitignore-oracle-cases-globstar'
export { PATH_ANCHOR_CASES } from './gitignore-oracle-cases-path'
export { REINCLUSION_CASES } from './gitignore-oracle-cases-reinclude'

export const GLOB_OP_CASES = [...GLOB_OP_CASES_A, ...GLOB_OP_CASES_B] as const

export const ALL_CASES = [
	...BASIC_ENV_CASES,
	...GLOB_OP_CASES,
	...GLOBSTAR_CASES,
	...PATH_ANCHOR_CASES,
	...REINCLUSION_CASES,
] as const
