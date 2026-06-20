// @ts-nocheck
// 导入指纹生成器
import { generateFingerprint } from './fingerprint';

// 自定义Base64字符表
const CUSTOM_BASE64_CHARS = "DGi0YA7BemWnQjCl4_bR3f8SKIF9tUz/xhr2oEOgPpac=61ZqwTudLkM5vHyNXsVJ";

// 哈希字段位置（这些字段需要随机生成）
const HASH_FIELDS = {
    16: 'split',  // 插件哈希（格式: count|hash，只替换hash部分）
    17: 'full',   // Canvas指纹哈希
    18: 'full',   // UserAgent哈希
    31: 'full',   // UserAgent哈希2
    34: 'full',   // 文档URL哈希
    36: 'full'    // 文档属性哈希
};

// ==================== LZW压缩算法 ====================

function lzwCompress(data, bits, charFunc) {
    if (data == null) return '';

    let dict = {};
    let dictToCreate = {};
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

// ==================== 编码函数 ====================

function customEncode(data, urlSafe) {
    if (data == null) return '';

    const base64Chars = CUSTOM_BASE64_CHARS;

    let compressed = lzwCompress(data, 6, function(index) {
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

// ==================== 辅助函数 ====================

function randomHash() {
    return Math.floor(Math.random() * 4294967296);
}

function generateDeviceId() {
    return Array.from({ length: 20 }, () =>
        Math.floor(Math.random() * 16).toString(16)
    ).join('');
}

// ==================== 数据解析和处理 ====================

function parseRealData(realData) {
    const fields = realData.split('^');
    return fields;
}

function processFields(fields) {
    const processed = [...fields];
    const currentTimestamp = Date.now();

    // 替换哈希字段
    for (const [index, type] of Object.entries(HASH_FIELDS)) {
        const idx = parseInt(index);

        if (type === 'split') {
            // 字段16: 格式为 "count|hash"，只替换hash部分
            const parts = processed[idx].split('|');
            if (parts.length === 2) {
                processed[idx] = `${parts[0]}|${randomHash()}`;
            }
        } else if (type === 'full') {
            // 完全替换为随机哈希
            if (idx === 36) {
                // 字段36: 文档属性哈希（10-100的随机整数）
                processed[idx] = Math.floor(Math.random() * 91) + 10;
            } else {
                processed[idx] = randomHash();
            }
        }
    }

    processed[33] = currentTimestamp;  // 字段33: 当前时间戳

    return processed;
}

// ==================== Cookie生成 ====================

function generateCookies(realData = null, fingerprintOptions = {}) {
    // 使用传入的指纹或生成新的随机指纹
    const fingerprint = realData || generateFingerprint(fingerprintOptions);

    // 解析指纹数据
    const fields = parseRealData(fingerprint);

    // 处理字段（随机化哈希，更新时间戳）
    const processedFields = processFields(fields);

    // 生成 ssxmod_itna (37字段)
    const ssxmod_itna_data = processedFields.join('^');
    const ssxmod_itna = '1-' + customEncode(ssxmod_itna_data, true);

    // 生成 ssxmod_itna2 (18字段)
    // 只使用: 字段0, 字段1, 字段23, 字段32, 字段33
    const ssxmod_itna2_data = [
        processedFields[0],   // 设备ID
        processedFields[1],   // SDK版本
        processedFields[23],  // 模式 (P/M)
        0, '', 0, '', '', 0,  // 事件相关（P模式下为空）
        0, 0,
        processedFields[32],  // 常量 (11)
        processedFields[33],  // 当前时间戳
        0, 0, 0, 0, 0
    ].join('^');
    const ssxmod_itna2 = '1-' + customEncode(ssxmod_itna2_data, true);

    return {
        ssxmod_itna,
        ssxmod_itna2,
        timestamp: parseInt(processedFields[33]),
        rawData: ssxmod_itna_data,
        rawData2: ssxmod_itna2_data
    };
}

function generateBatch(count = 10, realData = null, fingerprintOptions = {}) {
    const results = [];
    for (let i = 0; i < count; i++) {
        results.push(generateCookies(realData, fingerprintOptions));
    }
    return results;
}

// ==================== 主程序 ====================



// ==================== 导出 ====================

export {
    generateCookies,
    generateBatch,
    customEncode,
    randomHash,
    generateDeviceId,
    parseRealData,
    generateFingerprint
};
