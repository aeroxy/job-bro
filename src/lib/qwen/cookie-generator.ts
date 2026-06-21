import { generateFingerprint, generateDeviceId, generateHash as randomHash, type FingerprintOptions } from './fingerprint';

export interface CookieResult {
    ssxmod_itna: string;
    ssxmod_itna2: string;
    timestamp: number;
    rawData: string;
    rawData2: string;
}

// Custom Base64 character table
const CUSTOM_BASE64_CHARS = "DGi0YA7BemWnQjCl4_bR3f8SKIF9tUz/xhr2oEOgPpac=61ZqwTudLkM5vHyNXsVJ";

// Hash field indices (these fields require random generation)
const HASH_FIELDS = {
    16: 'split',  // Plugin hash (format: count|hash, only replace the hash part)
    17: 'full',   // Canvas fingerprint hash
    18: 'full',   // UserAgent hash
    31: 'full',   // UserAgent hash2
    34: 'full',   // Document URL hash
    36: 'full'    // Document attributes hash
};

// ==================== LZW Compression Algorithm ====================

function lzwCompress(data: string | null, bits: number, charFunc: (index: number) => string): string {
    if (data == null) return '';

    let dict: Record<string, number> = {};
    let dictToCreate: Record<string, boolean> = {};
    let c = '';
    let wc = '';
    let w = '';
    let enlargeIn = 2;
    let dictSize = 3;
    let numBits = 2;
    let result = [];
    let value = 0;
    let position = 0;

    for (let i = 0; i < data.length; i++) {
        c = data.charAt(i);

        if (!Object.prototype.hasOwnProperty.call(dict, c)) {
            dict[c] = dictSize++;
            dictToCreate[c] = true;
        }

        wc = w + c;

        if (Object.prototype.hasOwnProperty.call(dict, wc)) {
            w = wc;
        } else {
            if (Object.prototype.hasOwnProperty.call(dictToCreate, w)) {
                if (w.charCodeAt(0) < 256) {
                    for (let j = 0; j < numBits; j++) {
                        value = (value << 1);
                        if (position === bits - 1) {
                            position = 0;
                            result.push(charFunc(value));
                            value = 0;
                        } else {
                            position++;
                        }
                    }

                    let charCode = w.charCodeAt(0);
                    for (let j = 0; j < 8; j++) {
                        value = (value << 1) | (charCode & 1);
                        if (position === bits - 1) {
                            position = 0;
                            result.push(charFunc(value));
                            value = 0;
                        } else {
                            position++;
                        }
                        charCode >>= 1;
                    }
                } else {
                    let charCode = 1;
                    for (let j = 0; j < numBits; j++) {
                        value = (value << 1) | charCode;
                        if (position === bits - 1) {
                            position = 0;
                            result.push(charFunc(value));
                            value = 0;
                        } else {
                            position++;
                        }
                        charCode = 0;
                    }

                    charCode = w.charCodeAt(0);
                    for (let j = 0; j < 16; j++) {
                        value = (value << 1) | (charCode & 1);
                        if (position === bits - 1) {
                            position = 0;
                            result.push(charFunc(value));
                            value = 0;
                        } else {
                            position++;
                        }
                        charCode >>= 1;
                    }
                }

                enlargeIn--;
                if (enlargeIn === 0) {
                    enlargeIn = Math.pow(2, numBits);
                    numBits++;
                }
                delete dictToCreate[w];
            } else {
                let charCode = dict[w];
                for (let j = 0; j < numBits; j++) {
                    value = (value << 1) | (charCode & 1);
                    if (position === bits - 1) {
                        position = 0;
                        result.push(charFunc(value));
                        value = 0;
                    } else {
                        position++;
                    }
                    charCode >>= 1;
                }
            }

            enlargeIn--;
            if (enlargeIn === 0) {
                enlargeIn = Math.pow(2, numBits);
                numBits++;
            }

            dict[wc] = dictSize++;
            w = String(c);
        }
    }

    if (w !== '') {
        if (Object.prototype.hasOwnProperty.call(dictToCreate, w)) {
            if (w.charCodeAt(0) < 256) {
                for (let j = 0; j < numBits; j++) {
                    value = (value << 1);
                    if (position === bits - 1) {
                        position = 0;
                        result.push(charFunc(value));
                        value = 0;
                    } else {
                        position++;
                    }
                }

                let charCode = w.charCodeAt(0);
                for (let j = 0; j < 8; j++) {
                    value = (value << 1) | (charCode & 1);
                    if (position === bits - 1) {
                        position = 0;
                        result.push(charFunc(value));
                        value = 0;
                    } else {
                        position++;
                    }
                    charCode >>= 1;
                }
            } else {
                let charCode = 1;
                for (let j = 0; j < numBits; j++) {
                    value = (value << 1) | charCode;
                    if (position === bits - 1) {
                        position = 0;
                        result.push(charFunc(value));
                        value = 0;
                    } else {
                        position++;
                    }
                    charCode = 0;
                }

                charCode = w.charCodeAt(0);
                for (let j = 0; j < 16; j++) {
                    value = (value << 1) | (charCode & 1);
                    if (position === bits - 1) {
                        position = 0;
                        result.push(charFunc(value));
                        value = 0;
                    } else {
                        position++;
                    }
                    charCode >>= 1;
                }
            }

            enlargeIn--;
            if (enlargeIn === 0) {
                enlargeIn = Math.pow(2, numBits);
                numBits++;
            }
            delete dictToCreate[w];
        } else {
            let charCode = dict[w];
            for (let j = 0; j < numBits; j++) {
                value = (value << 1) | (charCode & 1);
                if (position === bits - 1) {
                    position = 0;
                    result.push(charFunc(value));
                    value = 0;
                } else {
                    position++;
                }
                charCode >>= 1;
            }
        }

        enlargeIn--;
        if (enlargeIn === 0) {
            enlargeIn = Math.pow(2, numBits);
            numBits++;
        }
    }

    let charCode = 2;
    for (let j = 0; j < numBits; j++) {
        value = (value << 1) | (charCode & 1);
        if (position === bits - 1) {
            position = 0;
            result.push(charFunc(value));
            value = 0;
        } else {
            position++;
        }
        charCode >>= 1;
    }

    while (true) {
        value = (value << 1);
        if (position === bits - 1) {
            result.push(charFunc(value));
            break;
        }
        position++;
    }

    return result.join('');
}

// ==================== Encoding Functions ====================

function customEncode(data: string | null, urlSafe: boolean): string {
    if (data == null) return '';

    const base64Chars = CUSTOM_BASE64_CHARS;

    let compressed = lzwCompress(data, 6, function(index: number) {
        return base64Chars.charAt(index);
    });

    if (!urlSafe) {
        switch (compressed.length % 4) {
            case 1: return compressed + '===';
            case 2: return compressed + '==';
            case 3: return compressed + '=';
            default: return compressed;
        }
    }

    return compressed;
}

// ==================== Data Parsing and Processing ====================

function parseRealData(realData: string): string[] {
    const fields = realData.split('^');
    return fields;
}

function processFields(fields: string[]): (string | number)[] {
    const processed: (string | number)[] = [...fields];
    const currentTimestamp = Date.now();

    // Replace hash fields
    for (const [index, type] of Object.entries(HASH_FIELDS)) {
        const idx = parseInt(index);
        if (processed[idx] === undefined) continue;

        if (type === 'split') {
            // Field 16: Format is "count|hash", only replace the hash part
            const parts = String(processed[idx]).split('|');
            if (parts.length === 2) {
                processed[idx] = `${parts[0]}|${randomHash()}`;
            }
        } else if (type === 'full') {
            // Completely replace with random hash
            if (idx === 36) {
                // 字段36: Document attributes hash（10-100的随机整数）
                processed[idx] = Math.floor(Math.random() * 91) + 10;
            } else {
                processed[idx] = randomHash();
            }
        }
    }

    processed[33] = currentTimestamp;  // Field 33: Current timestamp

    return processed;
}

// ==================== Cookie Generation ====================

function generateCookies(realData: string | null = null, fingerprintOptions: FingerprintOptions = {}): CookieResult {
    // Use passed fingerprint or generate a new random one
    const fingerprint = realData || generateFingerprint(fingerprintOptions);

    // Parse fingerprint data
    const fields = parseRealData(fingerprint);

    // Process fields (randomize hashes, update timestamp)
    const processedFields = processFields(fields);

    // Generate ssxmod_itna (37 fields)
    const ssxmod_itna_data = processedFields.join('^');
    const ssxmod_itna = '1-' + customEncode(ssxmod_itna_data, true);

    // Generate ssxmod_itna2 (18 fields)
    // Only use: Field 0, Field 1, Field 23, Field 32, Field 33
    const ssxmod_itna2_data = [
        processedFields[0],   // Device ID
        processedFields[1],   // SDK version
        processedFields[23],  // Mode (P/M)
        0, '', 0, '', '', 0,  // Event related (empty under P mode)
        0, 0,
        processedFields[32],  // Constant (11)
        processedFields[33],  // Current timestamp
        0, 0, 0, 0, 0
    ].join('^');
    const ssxmod_itna2 = '1-' + customEncode(ssxmod_itna2_data, true);

    return {
        ssxmod_itna,
        ssxmod_itna2,
        timestamp: Number(processedFields[33]),
        rawData: ssxmod_itna_data,
        rawData2: ssxmod_itna2_data
    };
}

function generateBatch(count: number = 10, realData: string | null = null, fingerprintOptions: FingerprintOptions = {}): CookieResult[] {
    const results: CookieResult[] = [];
    for (let i = 0; i < count; i++) {
        results.push(generateCookies(realData, fingerprintOptions));
    }
    return results;
}

// ==================== Main ====================



// ==================== Exports ====================

export {
    generateCookies,
    generateBatch,
    customEncode,
    randomHash,
    generateDeviceId,
    parseRealData,
    generateFingerprint
};
