export interface FingerprintOptions {
  deviceId?: string;
  platform?: 'macIntel' | 'macM1' | 'win64' | 'linux';
  screen?: '1920x1080' | '2560x1440' | '1470x956' | '1440x900' | '1536x864';
  locale?: 'zh-CN' | 'zh-TW' | 'en-US' | 'ja-JP' | 'ko-KR';
  custom?: Record<string, string>;
}

const DEFAULT_TEMPLATE = {
    deviceId: '84985177a19a010dea49',
    sdkVersion: 'websdk-2.3.15d',
    initTimestamp: '1765348410850',
    field3: '91',
    field4: '1|15',
    language: 'zh-CN',
    timezoneOffset: '-480',
    colorDepth: '16705151|12791',
    screenInfo: '1470|956|283|797|158|0|1470|956|1470|798|0|0',
    field9: '5',
    platform: 'MacIntel',
    field11: '10',
    webglRenderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M4, Unspecified Version)|Google Inc. (Apple)',
    field13: '30|30',
    field14: '0',
    field15: '28',
    pluginCount: '5',
    vendor: 'Google Inc.',
    field29: '8',
    touchInfo: '-1|0|0|0|0',
    field32: '11',
    field35: '0',
    mode: 'P'
};

const SCREEN_PRESETS: Record<string, string> = {
    '1920x1080': '1920|1080|283|1080|158|0|1920|1080|1920|922|0|0',
    '2560x1440': '2560|1440|283|1440|158|0|2560|1440|2560|1282|0|0',
    '1470x956': '1470|956|283|797|158|0|1470|956|1470|798|0|0',
    '1440x900': '1440|900|283|900|158|0|1440|900|1440|742|0|0',
    '1536x864': '1536|864|283|864|158|0|1536|864|1536|706|0|0'
};

interface PlatformPreset {
  platform: string;
  webglRenderer: string;
  vendor: string;
}

const PLATFORM_PRESETS: Record<string, PlatformPreset> = {
    macIntel: {
        platform: 'MacIntel',
        webglRenderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M4, Unspecified Version)|Google Inc. (Apple)',
        vendor: 'Google Inc.'
    },
    macM1: {
        platform: 'MacIntel',
        webglRenderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)|Google Inc. (Apple)',
        vendor: 'Google Inc.'
    },
    win64: {
        platform: 'Win32',
        webglRenderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3080 Direct3D11 vs_5_0 ps_5_0, D3D11)|Google Inc. (NVIDIA)',
        vendor: 'Google Inc.'
    },
    linux: {
        platform: 'Linux x86_64',
        webglRenderer: 'ANGLE (Intel, Mesa Intel(R) UHD Graphics 630, OpenGL 4.6)|Google Inc. (Intel)',
        vendor: 'Google Inc.'
    }
};

interface LanguagePreset {
  language: string;
  timezoneOffset: string;
}

const LANGUAGE_PRESETS: Record<string, LanguagePreset> = {
    'zh-CN': { language: 'zh-CN', timezoneOffset: '-480' },
    'zh-TW': { language: 'zh-TW', timezoneOffset: '-480' },
    'en-US': { language: 'en-US', timezoneOffset: '480' },
    'ja-JP': { language: 'ja-JP', timezoneOffset: '-540' },
    'ko-KR': { language: 'ko-KR', timezoneOffset: '-540' }
};

function generateDeviceId(): string {
    return crypto.randomUUID();
}

function generateHash(): number {
    const array = new Uint32Array(1);
    crypto.getRandomValues(array);
    return array[0];
}

function generateFingerprint(options: FingerprintOptions = {}): string {
    const config = { ...DEFAULT_TEMPLATE };
    if (options.platform && PLATFORM_PRESETS[options.platform]) {
        Object.assign(config, PLATFORM_PRESETS[options.platform]);
    }
    if (options.screen && SCREEN_PRESETS[options.screen]) {
        config.screenInfo = SCREEN_PRESETS[options.screen];
    }
    if (options.locale && LANGUAGE_PRESETS[options.locale]) {
        Object.assign(config, LANGUAGE_PRESETS[options.locale]);
    }
    if (options.custom) {
        Object.assign(config, options.custom);
    }
    const deviceId = options.deviceId || generateDeviceId();
    const currentTimestamp = Date.now();
    const pluginHash = generateHash();
    const canvasHash = generateHash();
    const uaHash1 = generateHash();
    const uaHash2 = generateHash();
    const urlHash = generateHash();
    const docHash = Math.floor(Math.random() * 91) + 10;
    const fields = [
        deviceId,
        config.sdkVersion,
        config.initTimestamp,
        config.field3,
        config.field4,
        config.language,
        config.timezoneOffset,
        config.colorDepth,
        config.screenInfo,
        config.field9,
        config.platform,
        config.field11,
        config.webglRenderer,
        config.field13,
        config.field14,
        config.field15,
        `${config.pluginCount}|${pluginHash}`,
        canvasHash,
        uaHash1,
        '1',
        '0',
        '1',
        '0',
        config.mode,
        '0',
        '0',
        '0',
        '416',
        config.vendor,
        config.field29,
        config.touchInfo,
        uaHash2,
        config.field32,
        currentTimestamp,
        urlHash,
        config.field35,
        docHash
    ];
    return fields.join('^');
}

function generateFingerprintBatch(count: number, options: FingerprintOptions = {}): string[] {
    return Array.from({ length: count }, () => generateFingerprint(options));
}

interface ParsedFingerprint {
  deviceId: string;
  sdkVersion: string;
  initTimestamp: string;
  language: string;
  timezoneOffset: string;
  platform: string;
  webglRenderer: string;
  mode: string;
  vendor: string;
  timestamp: string;
  raw: string[];
}

function parseFingerprint(fingerprint: string): ParsedFingerprint {
    const fields = fingerprint.split('^');
    return {
        deviceId: fields[0],
        sdkVersion: fields[1],
        initTimestamp: fields[2],
        language: fields[5],
        timezoneOffset: fields[6],
        platform: fields[10],
        webglRenderer: fields[12],
        mode: fields[23],
        vendor: fields[28],
        timestamp: fields[33],
        raw: fields
    };
}

export {
    generateFingerprint,
    generateFingerprintBatch,
    parseFingerprint,
    generateDeviceId,
    generateHash,
    DEFAULT_TEMPLATE,
    SCREEN_PRESETS,
    PLATFORM_PRESETS,
    LANGUAGE_PRESETS
};
