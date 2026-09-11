import { Vault } from 'obsidian'
import { readLocalBinary } from '~/utils/local-vault-io'
import { sha256Hex } from '~/utils/sha256'

export async function hashArrayBuffer(data: ArrayBuffer): Promise<string> {
	return sha256Hex(data)
}

export async function hashLocalVaultFile(
	vault: Vault,
	path: string,
): Promise<string> {
	return sha256Hex(await readLocalBinary(vault, path))
}
