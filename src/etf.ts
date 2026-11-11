import type { Packer, Unpacker } from "wetf";

let codec: { packer: Packer; unpacker: Unpacker } | null = null;

/**
 * wetf's Packer and Unpacker.
 * @since 0.20.0
 */
export function getEtf(): { packer: Packer; unpacker: Unpacker } {
	if (codec) return codec;
	let wetf: typeof import("wetf");
	try {
		wetf = require("wetf");
	} catch (e) {
		throw new Error("etf encoding requires wetf. Install it with `npm i wetf` or use json encoding", { cause: e });
	}
	codec = {
		packer: new wetf.Packer({ encoding: { string: "binary", key: "binary", array: "list", undefined: "ignore", nan: "null", infinity: "null" } }),
		unpacker: new wetf.Unpacker({ cacheKeys: false, decoding: { nil: "array", string: "array", binary: "utf8", bigint: "string", safebigint: "number" } })
	};
	return codec;
}
