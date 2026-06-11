// ============================================
// UI 환경설정 (테마, 표시 옵션)
// localStorage 단일 키에 통합 저장
// ============================================

const STORAGE_KEY = 'chatLobby_uiPrefs';

const DEFAULTS = {
    theme: null,           // null = 레거시 키에서 마이그레이션
    showHero: true,        // 최애 코너 (히어로 배너)
    personaBadges: true,   // 캐릭터 카드 페르소나 배지
    cardSize: 200,         // 캐릭터 카드 폭 (px)
    badgeSize: 36,         // 페르소나 배지 크기 (px)
    badgePosition: 'top',  // 페르소나 배지 위치 ('top' = 우측 상단, 'bottom' = 우측 하단)
    viewerFontSize: 15,    // 리마인드 뷰어 글자 크기 (px)
    viewerPageSize: 10,    // 리마인드 뷰어 페이지당 메시지 수 (0 = 모두)
    viewerTheme: 'auto',   // 읽기 모드 테마 ('auto'|'dark'|'sepia'|'paper')
    viewerFontFamily: 'default', // 뷰어 폰트 ('default'|'serif'|'mono')
};

class UiPrefs {
    constructor() {
        /** @type {Object|null} */
        this._data = null;
    }

    _load() {
        if (this._data) return this._data;

        let saved = {};
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (raw) saved = JSON.parse(raw) || {};
        } catch (e) {
            console.warn('[UiPrefs] Failed to load:', e);
        }

        this._data = { ...DEFAULTS, ...saved };

        // 레거시 마이그레이션: 'chatlobby-theme' (dark|light) → theme id
        if (this._data.theme === null) {
            const legacy = localStorage.getItem('chatlobby-theme');
            this._data.theme = legacy === 'light' ? 'light' : 'default';
            this._save();
        }

        return this._data;
    }

    _save() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(this._data));
        } catch (e) {
            console.warn('[UiPrefs] Failed to save:', e);
        }
    }

    /**
     * @param {string} key
     * @returns {*}
     */
    get(key) {
        return this._load()[key];
    }

    /**
     * @param {string} key
     * @param {*} value
     */
    set(key, value) {
        this._load();
        this._data[key] = value;
        this._save();
    }
}

export const uiPrefs = new UiPrefs();
