// This ETF (External Term Format) encoder and decoder is originally from https://github.com/timotejroiko/tiny-discord
// later used in https://github.com/timotejroiko/wetf
// Modifications and use of this code was granted for this project by the author, Timotej Roiko.

export function read(data: Buffer, start: number): any {
	let view: DataView | undefined;
	let x = start;
	const loop = (): any => {
		const type = data[x++];
		switch(type) {
		case 70: {
			const float = data.readDoubleBE(x);
			x += 8;
			return float;
		}
		case 97: {
			return data[x++];
		}
		case 98: {
			const int = data.readInt32BE(x);
			x += 4;
			return int;
		}
		case 100: {
			const length = data.readUInt16BE(x);
			let atom = "";
			if (length > 30) {
				// @ts-ignore
				atom = data.latin1Slice(x += 2, x + length);
			} else {
				for (let i = x += 2; i < x + length; i++) {
					atom += String.fromCodePoint(data[i]);
				}
			}
			x += length;
			if (!atom) return undefined;
			if (atom === "nil" || atom === "null") return null;
			if (atom === "true") return true;
			if (atom === "false") return false;
			return atom;
		}
		case 108:
		case 106: {
			const array = [] as Array<any>;
			if (type === 108) {
				const length = data.readUInt32BE(x);
				x += 4;
				for (let i = 0; i < length; i++) {
					array.push(loop());
				}
				x++;
			}
			return array;
		}
		case 107: {
			const array = [] as Array<number>;
			const length = data.readUInt16BE(x);
			x += 2;
			for (let i = 0; i < length; i++) {
				array.push(data[x++]);
			}
			return array;
		}
		case 109: {
			const length = data.readUInt32BE(x);
			let str = "";
			if (length > 30) {
				// @ts-ignore
				str = data.utf8Slice(x += 4, x + length);
			} else {
				let i = x += 4;
				const l = x + length;
				while(i < l) {
					const byte = data[i++];
					if (byte < 128) str += String.fromCodePoint(byte);
					else if (byte < 224) str += String.fromCodePoint(((byte & 31) << 6) + (data[i++] & 63));
					else if (byte < 240) str += String.fromCodePoint(((byte & 15) << 12) + ((data[i++] & 63) << 6) + (data[i++] & 63));
					else str += String.fromCodePoint(((byte & 7) << 18) + ((data[i++] & 63) << 12) + ((data[i++] & 63) << 6) + (data[i++] & 63));
				}
			}
			x += length;
			return str;
		}
		case 110: {
			// @ts-ignore
			view ??= new DataView(data.buffer, data.offset, data.byteLength);
			const length = data[x++];
			const sign = data[x++];
			let left = length;
			let num = BigInt(0);
			while(left > 0) {
				if (left >= 8) {
					num <<= BigInt(64);
					num += view.getBigUint64(x + (left -= 8), true);
				} else if (left >= 4) {
					num <<= BigInt(32);
					num += BigInt(view.getUint32(x + (left -= 4), true));
				} else if (left >= 2) {
					num <<= BigInt(16);
					num += BigInt(view.getUint16(x + (left -= 2), true));
				} else {
					num <<= BigInt(8);
					num += BigInt(data[x]);
					left--;
				}
			}
			x += length;
			return (sign ? -num : num).toString();
		}
		case 116: {
			const obj = {};
			const length = data.readUInt32BE(x);
			x += 4;
			for(let i = 0; i < length; i++) {
				const key = loop();
				// @ts-ignore
				obj[key] = loop();
			}
			return obj;
		}
		}
		throw new Error(`Missing etf type: ${type}`);
	};
	return loop();
}

/** Values that have no ETF representation, dropped from maps and encoded as nil in lists - the same rules JSON.stringify applies. */
function isUnencodable(value: any): boolean {
	return value === undefined || typeof value === "function" || typeof value === "symbol";
}

export function write(data: any): Buffer {
	let b = Buffer.allocUnsafe(1 << 12);
	b[0] = 131;
	let i = 1;
	// Grows the backing buffer if the next write of n bytes wouldn't fit. Buffer writes past the end either throw or silently truncate, corrupting the payload
	const reserve = (n: number) => {
		if (i + n <= b.length) return;
		let size = b.length;
		do size *= 2; while (size < i + n);
		const resized = Buffer.allocUnsafe(size);
		b.copy(resized, 0, 0, i);
		b = resized;
	};
	const loop = (obj: any) => {
		const type = typeof obj;
		switch(type) {
		case "boolean": {
			reserve(8);
			b[i++] = 100;
			if (obj) {
				b.writeUInt16BE(4, i);
				// @ts-ignore
				b.latin1Write("true", i += 2);
				i += 4;
			} else {
				b.writeUInt16BE(5, i);
				// @ts-ignore
				b.latin1Write("false", i += 2);
				i += 5;
			}
			break;
		}
		case "string": {
			const length = Buffer.byteLength(obj);
			reserve(5 + length);
			b[i++] = 109;
			b.writeUInt32BE(length, i);
			// @ts-ignore
			b.utf8Write(obj, i += 4);
			i += length;
			break;
		}
		case "number": {
			reserve(11);
			if (Number.isInteger(obj)) {
				const abs = Math.abs(obj);
				if (abs < 2147483648) {
					b[i++] = 98;
					b.writeInt32BE(obj, i);
					i += 4;
				} else if (abs < Number.MAX_SAFE_INTEGER) {
					b[i++] = 110;
					b[i++] = 8;
					b[i++] = Number(obj < 0);
					b.writeBigUInt64LE(BigInt(abs), i);
					i += 8;
					break;
				} else {
					b[i++] = 70;
					b.writeDoubleBE(obj, i);
					i += 8;
				}
			} else {
				b[i++] = 70;
				b.writeDoubleBE(obj, i);
				i += 8;
			}
			break;
		}
		case "bigint": {
			reserve(11);
			b[i++] = 110;
			b[i++] = 8;
			b[i++] = Number(obj < 0);
			b.writeBigUInt64LE(obj < 0 ? -obj : obj, i);
			i += 8;
			break;
		}
		case "object": {
			if (obj === null) {
				reserve(6);
				b[i++] = 100;
				b.writeUInt16BE(3, i);
				// @ts-ignore
				b.latin1Write("nil", i += 2);
				i += 3;
			} else if (Array.isArray(obj)) {
				if (obj.length) {
					reserve(5);
					b[i++] = 108;
					b.writeUInt32BE(obj.length, i);
					i += 4;
					for (const item of obj) {
						// The length prefix above already promised an element. Skipping unencodables (like maps do)
						// would corrupt the whole payload, so follow JSON.stringify and encode them as null
						loop(isUnencodable(item) ? null : item);
					}
				}
				reserve(1);
				b[i++] = 106;
			} else {
				const entries = Object.entries(obj).filter(x => !isUnencodable(x[1]));
				reserve(5);
				b[i++] = 116;
				b.writeUInt32BE(entries.length, i);
				i += 4;
				for(const [key, value] of entries) {
					loop(key);
					loop(value);
				}
			}
			break;
		}
		}
	};
	loop(data);
	return Buffer.from(b.subarray(0, i));
}
